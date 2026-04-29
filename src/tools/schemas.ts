export const tools = [
  {
    type: "function",
    function: {
      name: "Read",
      description: "reads and returns file contents",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Path of the file to read.",
          },
        },
        required: ["file_path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Write",
      description: "creates or overwrites a file with the given contents",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Path of the file to create or overwrite.",
          },
          content: {
            type: "string",
            description: "Text content to write into the file.",
          },
        },
        required: ["file_path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Bash",
      description: "runs a shell command and returns stdout, stderr, and exit code",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Shell command to execute.",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
] as const;
