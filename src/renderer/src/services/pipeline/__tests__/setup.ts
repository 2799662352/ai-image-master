import { vi } from 'vitest'

vi.mock('@langchain/google', () => ({
  ChatGoogleGenerativeAI: vi.fn().mockImplementation(() => ({
    withStructuredOutput: vi.fn().mockReturnThis(),
    invoke: vi.fn(),
  })),
}))

vi.mock('@langchain/openai', () => ({
  ChatOpenAI: vi.fn().mockImplementation(() => ({
    withStructuredOutput: vi.fn().mockReturnThis(),
    invoke: vi.fn(),
  })),
}))
