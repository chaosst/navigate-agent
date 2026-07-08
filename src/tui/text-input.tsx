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
 * Raw stdin input handler with history, bracketed paste, and IME support.
 */
export function ControlledTextInput({ value, onChange, onSubmit, disabled, placeholder }: TextInputProps) {
  const bufferRef = useRef(value);
  const historyRef = useRef<string[]>([]);
  const historyIdxRef = useRef(-1);
  const pastingRef = useRef(false);

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
      const raw = data.toString("utf-8");

      // Bracketed paste markers
      // Paste markers in their own chunks
      if (raw === "\x1b[200~") { pastingRef.current = true; return; }
      if (raw === "\x1b[201~") { pastingRef.current = false; return; }
      // Paste text in separate chunk(s) — accumulate directly
      if (pastingRef.current) {
        const pe = raw.indexOf("\x1b[201~");
        if (pe >= 0) {
          bufferRef.current += raw.slice(0, pe);
          onChange(bufferRef.current);
          pastingRef.current = false;
          const after = raw.slice(pe + 6);
          if (after) buf += after;
        } else {
          bufferRef.current += raw;
          onChange(bufferRef.current);
        }
        return;
      }
      buf += raw;

      while (buf.length > 0) {
        // --- Bracketed paste handling (marker may be adjacent to paste text) ---
        const ps = buf.indexOf("\x1b[200~");
        if (ps >= 0) {
          // Text before the marker is normal input (unlikely but handle it)
          if (ps > 0) { /* process buf.slice(0, ps) as normal — will fall through */ }
          pastingRef.current = true;
          buf = buf.slice(ps + 6); // skip the marker
          // Collect all text until end marker (may not be in this chunk)
          const pe = buf.indexOf("\x1b[201~");
          if (pe >= 0) {
            // Complete paste in one chunk
            const pasteText = buf.slice(0, pe);
            if (pasteText) { bufferRef.current += pasteText; onChange(bufferRef.current); }
            buf = buf.slice(pe + 6);
            pastingRef.current = false;
          }
          // If no end marker yet, remaining buf IS the paste text — accumulate
          continue;
        }
        if (pastingRef.current) {
          const pe = buf.indexOf("\x1b[201~");
          if (pe >= 0) {
            const pasteText = buf.slice(0, pe);
            if (pasteText) { bufferRef.current += pasteText; onChange(bufferRef.current); }
            buf = buf.slice(pe + 6);
            pastingRef.current = false;
          } else {
            // More paste text, no end marker yet
            bufferRef.current += buf;
            onChange(bufferRef.current);
            buf = "";
          }
          continue;
        }

        const ch = buf[0];

        // ESC sequences
        if (ch === "\x1b") {
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
          } else {
            buf = buf.slice(1);
          }
          continue;
        }

        // Ctrl+C
        if (ch === "\x03") { buf = buf.slice(1); process.exit(0); }

        // Ctrl+U
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

        // Multi-byte UTF-8: determine byte length from first byte
        const cc = ch.charCodeAt(0);
        if (cc >= 0x20 && cc !== 0x7f) {
          // ASCII printable
          buf = buf.slice(1);
          bufferRef.current += ch;
          onChange(bufferRef.current);
        } else if (cc >= 0x80) {
          let len = 1;
          if ((cc & 0xe0) === 0xc0) len = 2;
          else if ((cc & 0xf0) === 0xe0) len = 3;
          else if ((cc & 0xf8) === 0xf0) len = 4;
          if (buf.length >= len) {
            bufferRef.current += buf.slice(0, len);
            buf = buf.slice(len);
            onChange(bufferRef.current);
          } else break; // incomplete — wait for more data
        } else {
          buf = buf.slice(1); // skip other control chars
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
