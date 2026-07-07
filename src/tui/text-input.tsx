import React, { useEffect, useRef } from "react";
import { Text } from "ink";

interface TextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function ControlledTextInput({ value, onChange, onSubmit, disabled, placeholder }: TextInputProps) {
  const bufferRef = useRef(value);
  useEffect(() => { bufferRef.current = value; }, [value]);
  useEffect(() => {
    if (disabled) return;
    const handler = (data: Buffer) => {
      const str = data.toString();
      for (const char of str) {
        if (char === "\r" || char === "\n") {
          onSubmit(bufferRef.current);
          onChange("");
        } else if (char === "\x7f" || char === "\b") {
          bufferRef.current = bufferRef.current.slice(0, -1);
          onChange(bufferRef.current);
        } else if (char === "\x03") {
          process.exit(0);
        } else if (char.length === 1 && char >= " ") {
          bufferRef.current += char;
          onChange(bufferRef.current);
        }
      }
    };
    process.stdin.on("data", handler);
    process.stdin.setRawMode?.(true);
    return () => {
      process.stdin.off("data", handler);
      process.stdin.setRawMode?.(false);
    };
  }, [disabled, onChange, onSubmit]);
  return (<Text color="white">{value || (placeholder ? <Text dimColor>{placeholder}</Text> : null)}<Text backgroundColor="gray"> </Text></Text>);
}
