import React, {
  useEffect,
  useRef,
  useCallback,
  useReducer,
} from "react";
import { Text } from "ink";

interface TextInputProps {
  onSubmit: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  agentMode?: string;
  onToggleAgentMode?: () => void;
}

/**
 * Uncontrolled terminal text input with full bracketed paste support,
 * cursor-based line editing, and robust CSI sequence parsing.
 *
 * The component manages its own state internally via refs and does NOT
 * lift the current value to the parent on every keystroke. This is
 * critical for performance: lifting the value would cause the entire
 * App tree (including the Output / message list) to re-render on every
 * character typed, producing visible flicker in the terminal.
 *
 * The only outward callback is `onSubmit`, fired when the user presses
 * Enter.
 *
 * Features:
 * - Bracketed paste: terminal is put into paste mode (\x1b[?2004h).
 *   Content between \x1b[200~ and \x1b[201~ is buffered atomically.
 *   All characters within paste (including \r, \n, \t) are preserved
 *   and never trigger submit/clear. Line endings are normalised to \n.
 * - Cursor navigation: Left/Right arrows, Home/End, Ctrl+A/E/B/F
 * - Line editing: Backspace, Delete, Ctrl+W (delete word), Ctrl+K (kill to end)
 * - History: Up/Down arrows through session command history
 * - Ctrl+U: clear entire line  Ctrl+C: exit
 *
 * CSI sequence parsing scans for the final byte (0x40-0x7E) instead of
 * assuming fixed-length sequences, so it correctly handles argument
 * bytes in sequences like \x1b[1;5D.
 */
export function ControlledTextInput({
  onSubmit,
  disabled,
  placeholder,
  agentMode,
  onToggleAgentMode,
}: TextInputProps) {
  const textRef = useRef("");
  const cursorRef = useRef(0);
  const historyRef = useRef<string[]>([]);
  const historyIdxRef = useRef(-1);
  const pasteModeRef = useRef(false);
  const pasteAccRef = useRef("");

  // forceRender triggers a local re-render so the visible text and
  // cursor position update. Because the component is uncontrolled,
  // this is the ONLY mechanism that causes it to re-render.
  const [, forceRender] = useReducer((x: number) => x + 1, 0);

  const commitLine = useCallback(
    (line: string) => {
      const trimmed = line.trim();
      if (trimmed) {
        historyRef.current.push(trimmed);
        if (historyRef.current.length > 100) historyRef.current.shift();
      }
      historyIdxRef.current = -1;
      onSubmit(trimmed);
      textRef.current = "";
      cursorRef.current = 0;
      forceRender();
    },
    [onSubmit],
  );

  useEffect(() => {
    if (disabled) return;

    let buf = "";

    // ------------------------------------------------------------------
    // Helpers (operate on refs directly, call forceRender)
    // ------------------------------------------------------------------

    const notify = () => {
      forceRender();
    };

    const moveLeft = () => {
      if (cursorRef.current > 0) {
        cursorRef.current--;
        forceRender();
      }
    };

    const moveRight = () => {
      if (cursorRef.current < textRef.current.length) {
        cursorRef.current++;
        forceRender();
      }
    };

    const moveHome = () => {
      cursorRef.current = 0;
      forceRender();
    };

    const moveEnd = () => {
      cursorRef.current = textRef.current.length;
      forceRender();
    };

    const deleteBefore = () => {
      if (cursorRef.current > 0) {
        textRef.current =
          textRef.current.slice(0, cursorRef.current - 1) +
          textRef.current.slice(cursorRef.current);
        cursorRef.current--;
        notify();
      }
    };

    const deleteAt = () => {
      if (cursorRef.current < textRef.current.length) {
        textRef.current =
          textRef.current.slice(0, cursorRef.current) +
          textRef.current.slice(cursorRef.current + 1);
        notify();
      }
    };

    const deleteWordBefore = () => {
      if (cursorRef.current === 0) return;
      const before = textRef.current.slice(0, cursorRef.current);
      let i = before.length;
      // Skip trailing whitespace
      while (i > 0 && /\s/.test(before[i - 1])) i--;
      // Skip word characters
      while (i > 0 && /\S/.test(before[i - 1])) i--;
      if (i < before.length) {
        textRef.current =
          before.slice(0, i) + textRef.current.slice(cursorRef.current);
        cursorRef.current = i;
        notify();
      }
    };

    const killToEnd = () => {
      if (cursorRef.current < textRef.current.length) {
        textRef.current = textRef.current.slice(0, cursorRef.current);
        notify();
      }
    };

    const insertAtCursor = (s: string) => {
      textRef.current =
        textRef.current.slice(0, cursorRef.current) +
        s +
        textRef.current.slice(cursorRef.current);
      cursorRef.current += s.length;
      notify();
    };

    // ------------------------------------------------------------------
    // CSI sequence length: scan for final byte 0x40-0x7E
    // Returns 0 when the sequence is incomplete (need more data).
    // ------------------------------------------------------------------
    const csiLength = (b: string): number => {
      if (b.length < 2) return 0;
      if (b[1] !== "[") return 1; // standalone ESC
      for (let i = 2; i < b.length; i++) {
        const c = b.charCodeAt(i);
        if (c >= 0x40 && c <= 0x7e) return i + 1;
      }
      return 0; // incomplete CSI — wait for more data
    };

    // ------------------------------------------------------------------
    // CSI dispatch
    // ------------------------------------------------------------------
    const handleCSI = (seq: string): void => {
      const final = seq[seq.length - 1];
      const params = seq.slice(2, -1); // between '[' and final

      if (final === "A") {
        // Up arrow — history
        if (historyIdxRef.current < historyRef.current.length - 1) {
          historyIdxRef.current++;
          const h =
            historyRef.current[
              historyRef.current.length - 1 - historyIdxRef.current
            ];
          textRef.current = h;
          cursorRef.current = h.length;
          notify();
        }
      } else if (final === "B") {
        // Down arrow — history
        if (historyIdxRef.current > 0) {
          historyIdxRef.current--;
          const h =
            historyRef.current[
              historyRef.current.length - 1 - historyIdxRef.current
            ];
          textRef.current = h;
          cursorRef.current = h.length;
          notify();
        } else if (historyIdxRef.current === 0) {
          historyIdxRef.current = -1;
          textRef.current = "";
          cursorRef.current = 0;
          notify();
        }
      } else if (final === "C") {
        moveRight();
      } else if (final === "D") {
        moveLeft();
      } else if (final === "H") {
        moveHome();
      } else if (final === "F") {
        moveEnd();
      } else if (final === "~") {
        if (params === "3") {
          deleteAt();              // Delete key
        } else if (params === "1" || params === "7") {
          moveHome();              // Home (VT)
        } else if (params === "4" || params === "8") {
          moveEnd();               // End (VT)
        } else if (params === "200") {
          // Bracketed paste start — enter paste mode
          pasteModeRef.current = true;
          pasteAccRef.current = "";
        }
        // params === "201" (paste end) is handled in the paste-mode
        // branch of the main loop, not here.
        // Other ~ sequences silently ignored.
      } else if (final === "Z") {
        // Shift+Tab → toggle plan mode (most terminals send \x1b[Z for Shift+Tab)
        if (onToggleAgentMode) {
          onToggleAgentMode();
        }
      }
      // Unknown CSI — silently consumed
    };

    // ------------------------------------------------------------------
    // Control-key dispatch (0x00–0x1F, excluding \r \n handled above)
    // ------------------------------------------------------------------
    const handleControl = (code: number): void => {
      switch (code) {
        case 0x01: moveHome(); break;          // Ctrl+A
        case 0x02: moveLeft(); break;          // Ctrl+B
        case 0x03: process.exit(0);            // Ctrl+C
        case 0x04: deleteAt(); break;          // Ctrl+D (delete forward)
        case 0x05: moveEnd(); break;           // Ctrl+E
        case 0x06: moveRight(); break;         // Ctrl+F
        case 0x08: deleteBefore(); break;      // Ctrl+H (backspace)
        case 0x0b: killToEnd(); break;         // Ctrl+K
        case 0x15:                             // Ctrl+U — clear line
          textRef.current = "";
          cursorRef.current = 0;
          notify();
          break;
        case 0x17: deleteWordBefore(); break;  // Ctrl+W
        // Other control chars silently skipped
      }
    };

    // ------------------------------------------------------------------
    // Main stdin handler
    // ------------------------------------------------------------------
    const handler = (data: Buffer) => {
      buf += data.toString("utf-8");

      while (buf.length > 0) {
        // ---- Paste mode: accumulate until end marker ----
        // This check is INSIDE the while loop so that when handleCSI
        // sets pasteModeRef.current = true mid-iteration, the very next
        // iteration picks up the remaining buffer as paste content
        // instead of processing it character by character.
        if (pasteModeRef.current) {
          const endIdx = buf.indexOf("\x1b[201~");
          if (endIdx === -1) {
            // End marker not yet received — keep accumulating
            pasteAccRef.current += buf;
            buf = "";
            return; // wait for more data
          }
          // Found end marker — extract everything before it
          pasteAccRef.current += buf.slice(0, endIdx);
          buf = buf.slice(endIdx + 6);
          pasteModeRef.current = false;

          // Normalise line endings: \r\n → \n, standalone \r → \n
          const content = pasteAccRef.current
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "\n");
          pasteAccRef.current = "";
          insertAtCursor(content);
          continue; // process any remaining buf after the end marker
        }

        const ch = buf[0];
        const cc = ch.charCodeAt(0);

        // ESC sequences
        if (cc === 0x1b) {
          const len = csiLength(buf);
          if (len === 0) return; // incomplete — wait for more data
          if (len === 1) {
            buf = buf.slice(1); // standalone ESC
          } else {
            handleCSI(buf.slice(0, len));
            buf = buf.slice(len);
          }
          continue;
        }

        // Enter / Return
        if (cc === 0x0d) {
          if (buf.length >= 2 && buf[1] === "\n") buf = buf.slice(2);
          else buf = buf.slice(1);
          commitLine(textRef.current);
          continue;
        }
        if (cc === 0x0a) {
          buf = buf.slice(1);
          commitLine(textRef.current);
          continue;
        }

        // Backspace (DEL 0x7f)
        if (cc === 0x7f) {
          buf = buf.slice(1);
          deleteBefore();
          continue;
        }

        // Control characters (0x00–0x1F)
        if (cc < 0x20) {
          buf = buf.slice(1);
          handleControl(cc);
          continue;
        }

        // Printable characters (>= 0x20, excluding 0x7f already handled)
        if (cc >= 0x20) {
          buf = buf.slice(1);
          insertAtCursor(ch);
        } else {
          buf = buf.slice(1); // skip unreachable
        }
      }
    };

    // Enable bracketed paste mode so the terminal wraps pasted content
    // with \x1b[200~ ... \x1b[201~ markers.
    process.stdout.write("\x1b[?2004h");
    process.stdin.on("data", handler);
    process.stdin.setRawMode?.(true);

    return () => {
      process.stdin.off("data", handler);
      process.stdin.setRawMode?.(false);
      process.stdout.write("\x1b[?2004l");
    };
  }, [disabled, commitLine, onToggleAgentMode]);

  // --------------------------------------------------------------------
  // Render — read directly from refs (uncontrolled)
  // --------------------------------------------------------------------
  const display = textRef.current || "";
  const cursorPos = Math.min(cursorRef.current, display.length);

  if (!display && placeholder) {
    return (
      <Text color="white">
        <Text dimColor>{placeholder}</Text>
        <Text backgroundColor="gray"> </Text>
      </Text>
    );
  }

  return (
    <Text color="white">
      {display.slice(0, cursorPos)}
      <Text backgroundColor="gray">
        {display[cursorPos] || " "}
      </Text>
      {display.slice(cursorPos + 1)}
    </Text>
  );
}
