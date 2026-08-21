import React from "react";
import { Box, Text } from "ink";
import { ControlledTextInput } from "./text-input.js";

interface InputProps {
  onSubmit: (value: string) => void;
  disabled: boolean;
  planMode?: boolean;
  onTogglePlanMode?: () => void;
}

export function Input({ onSubmit, disabled, planMode, onTogglePlanMode }: InputProps) {
  return (
    <Box borderStyle="round" borderColor={planMode ? "magenta" : "cyan"} paddingX={1}>
      <Text bold color={planMode ? "magenta" : "cyan"}>
        {planMode ? "[Plan] " : "> "}
      </Text>
      <ControlledTextInput
        onSubmit={onSubmit}
        disabled={disabled}
        placeholder={planMode ? "Plan mode — Shift+Tab to toggle..." : "Type your message..."}
        planMode={planMode}
        onTogglePlanMode={onTogglePlanMode}
      />
    </Box>
  );
}
