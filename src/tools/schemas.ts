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
  {
    type: "function",
    function: {
      name: "SearchFiles",
      description:
        "searches project file names and returns matching relative paths; use this before Read when the exact file path is unknown",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "File name or partial file path to search for.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "TypeCheck",
      description:
        "runs the project's TypeScript typecheck command and returns stdout, stderr, and exit code",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
] as const;
