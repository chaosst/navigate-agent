import React from "react";
import { Box, Text } from "ink";
import { ControlledTextInput } from "./text-input.js";

interface InputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled: boolean;
}

export function Input({ value, onChange, onSubmit, disabled }: InputProps) {
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">&gt; </Text>
      <ControlledTextInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        disabled={disabled}
        placeholder="Type your message..."
      />
    </Box>
  );
}
