export const mockPrompts = jest.fn();

const queuedResponses: unknown[] = [];

export const queuePromptResponse = (value: unknown) => {
  queuedResponses.push(value);
};

export const resetPromptsMocks = () => {
  mockPrompts.mockReset();
  queuedResponses.length = 0;
  mockPrompts.mockImplementation(async () => queuedResponses.shift() || {});
};

resetPromptsMocks();

export default (...args: Parameters<typeof mockPrompts>) => mockPrompts(...args);
