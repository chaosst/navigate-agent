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
 * Multi-line raw stdin input handler with history, paste, and IME support.
 *
 * Arrow Up/Down  — cycle through command history
 * Ctrl+U        — clear line
 * Ctrl+C        — exit
 * Backspace     — delete last char
 * Paste / IME   — handled via buffer accumulation
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
      buf += data.toString("utf-8");

      // Process complete sequences from the buffer
      while (buf.length > 0) {
        // Escape sequences: \x1b[... (CSI) or \x1b + single char
        if (buf[0] === "\x1b") {
          if (buf.length >= 3 && buf[1] === "[") {
            const csi = buf[2];
            if (buf.length >= 3) {
              buf = buf.slice(3);
              if (csi === "A") {
                // Arrow Up
                if (historyIdxRef.current < historyRef.current.length - 1) {
                  historyIdxRef.current++;
                  bufferRef.current = historyRef.current[historyRef.current.length - 1 - historyIdxRef.current];
                  onChange(bufferRef.current);
                }
              } else if (csi === "B") {
                // Arrow Down
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
              // Ignore other CSI sequences (left/right/home/end/del)
            }
          } else if (buf.length >= 2) {
            // Single-char escape (e.g. ESC alone)
            buf = buf.slice(2);
          }
          continue;
        }

        // Ctrl+C
        if (buf[0] === "\x03") {
          buf = buf.slice(1);
          process.exit(0);
        }

        // Ctrl+U — clear line
        if (buf[0] === "\x15") {
          buf = buf.slice(1);
          bufferRef.current = "";
          onChange("");
          continue;
        }

        // Backspace / DEL
        if (buf[0] === "\x7f" || buf[0] === "\b") {
          buf = buf.slice(1);
          bufferRef.current = bufferRef.current.slice(0, -1);
          onChange(bufferRef.current);
          continue;
        }

        // Enter
        if (buf[0] === "\r" || buf[0] === "\n") {
          buf = buf.slice(1);
          commitLine(bufferRef.current);
          continue;
        }

        // Regular visible character or multi-byte sequence
        // Consume one character (may be multi-byte UTF-8)
        const char = buf[0];
        const codePoint = char.charCodeAt(0);

        if (codePoint >= 0x20 && codePoint !== 0x7f) {
          // Single-byte ASCII printable
          buf = buf.slice(1);
          bufferRef.current += char;
          onChange(bufferRef.current);
        } else if (codePoint >= 0x80) {
          // Multi-byte UTF-8: find where this character ends
          let byteLen = 1;
          if ((codePoint & 0xe0) === 0xc0) byteLen = 2;
          else if ((codePoint & 0xf0) === 0xe0) byteLen = 3;
          else if ((codePoint & 0xf8) === 0xf0) byteLen = 4;

          if (buf.length >= byteLen) {
            bufferRef.current += buf.slice(0, byteLen);
            buf = buf.slice(byteLen);
            onChange(bufferRef.current);
          } else {
            // Incomplete multi-byte — wait for more data
            break;
          }
        } else {
          // Non-printable control char — skip
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
