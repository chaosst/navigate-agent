import React, { useEffect, useRef, useCallback } from "react";
import { Text } from "ink";

interface TextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

/**
 * Raw stdin input handler with history and bracketed paste support.
 *
 * All input (including bracketed paste) flows through a single path:
 * buf -> while loop. Paste markers \x1b[200~ and \x1b[201~ are skipped
 * by the ESC/CSI handler before generic CSI stripping can corrupt them.
 * Multi-byte characters are single decoded code points
 * (data.toString("utf-8") handles byte-to-char decoding).
 */
export function ControlledTextInput({ value, onChange, onSubmit, disabled, placeholder }: TextInputProps) {
  const bufferRef = useRef(value);
  const historyRef = useRef<string[]>([]);
  const historyIdxRef = useRef(-1);

  useEffect(() => { bufferRef.current = value; }, [value]);

  const commitLine = useCallback((line: string) => {
    const trimmed = line.trim();
    if (trimmed) {
      historyRef.current.push(trimmed);
      if (historyRef.current.length > 100) historyRef.current.shift();
    }
    historyIdxRef.current = -1;
    onSubmit(trimmed);
    onChange("");
  }, [onSubmit, onChange]);

  useEffect(() => {
    if (disabled) return;

    let buf = "";

    const handler = (data: Buffer) => {
      // toString("utf-8") decodes raw bytes to proper JavaScript characters.
      buf += data.toString("utf-8");

      while (buf.length > 0) {
        const ch = buf[0];

        // --- ESC / CSI sequences ---
        if (ch === "\x1b") {
          // Check complete bracketed paste markers BEFORE generic CSI stripping
          if (buf.length >= 6) {
            if (buf.startsWith("\x1b[200~")) { buf = buf.slice(6); continue; }
            if (buf.startsWith("\x1b[201~")) { buf = buf.slice(6); continue; }
          }
          // Generic CSI: arrow keys, home, end, etc.
          if (buf.length >= 3 && buf[1] === "[") {
            const csi = buf[2];
            buf = buf.slice(3);
            if (csi === "A") {
              if (historyIdxRef.current < historyRef.current.length - 1) {
                historyIdxRef.current++;
                bufferRef.current = historyRef.current[historyRef.current.length - 1 - historyIdxRef.current];
                onChange(bufferRef.current);
              }
            } else if (csi === "B") {
              if (historyIdxRef.current > 0) {
                historyIdxRef.current--;
                bufferRef.current = historyRef.current[historyRef.current.length - 1 - historyIdxRef.current];
                onChange(bufferRef.current);
              } else if (historyIdxRef.current === 0) {
                historyIdxRef.current = -1;
                bufferRef.current = "";
                onChange("");
              }
            }
            // Other CSI sequences (C, D, H, F, etc.) silently consumed
          } else {
            buf = buf.slice(1); // standalone ESC
          }
          continue;
        }

        // Ctrl+C
        if (ch === "\x03") { buf = buf.slice(1); process.exit(0); }

        // Ctrl+U - clear line
        if (ch === "\x15") { buf = buf.slice(1); bufferRef.current = ""; onChange(""); continue; }

        // Backspace
        if (ch === "\x7f" || ch === "\b") {
          buf = buf.slice(1);
          bufferRef.current = bufferRef.current.slice(0, -1);
          onChange(bufferRef.current);
          continue;
        }

        // Enter
        if (ch === "\r" || ch === "\n") { buf = buf.slice(1); commitLine(bufferRef.current); continue; }

        // Printable characters: ASCII >= 0x20 and already-decoded multi-byte characters
        const cc = ch.charCodeAt(0);
        if (cc >= 0x20 && cc !== 0x7f) {
          buf = buf.slice(1);
          bufferRef.current += ch;
          onChange(bufferRef.current);
        } else {
          // Skip other control characters (0x00-0x1F, 0x7f)
          buf = buf.slice(1);
        }
      }
    };

    process.stdin.on("data", handler);
    process.stdin.setRawMode?.(true);
    return () => {
      process.stdin.off("data", handler);
      process.stdin.setRawMode?.(false);
    };
  }, [disabled, onChange, commitLine]);

  const display = value || "";
  return (
    <Text color="white">
      {display}
      {(placeholder && !value) ? <Text dimColor>{placeholder}</Text> : null}
      <Text backgroundColor="gray"> </Text>
    </Text>
  );
}
