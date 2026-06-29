import type { StubToolDef } from '../harness/runCodex'

/**
 * Canned, catimation-shaped tools shared across routing scenarios. Descriptions
 * mirror the REAL tools closely enough that the agent routes the same way it
 * would in the app, but every call returns a deterministic stub payload so the
 * loop never touches the renderer / network.
 */

export const ASK_USER_TOOL: StubToolDef = {
  name: 'ask_user',
  description:
    'Show an interactive, clickable choice card in CATIMATION chat. Use whenever you would otherwise list 2+ options for the user to pick between (creative directions, ambiguous decisions). Do NOT use it to render images.',
  inputSchema: {
    type: 'object',
    required: ['question', 'options'],
    properties: {
      question: { type: 'string' },
      options: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'label'],
          properties: { id: { type: 'string' }, label: { type: 'string' } },
        },
      },
    },
  },
  cannedResult: { selected: [{ id: 'opt_1', label: 'Option 1' }], freeText: '' },
}

export const GENERATE_IMAGE_TOOL: StubToolDef = {
  name: 'generate_image',
  description:
    'Render an image from a text prompt and show it in chat + save to history. Use this for any concrete "draw/generate/make a picture of X" request. Returns saved file paths.',
  inputSchema: {
    type: 'object',
    required: ['prompt'],
    properties: {
      prompt: { type: 'string', description: 'The image description.' },
      count: { type: 'number' },
    },
  },
  cannedResult: { paths: ['file:///tmp/eval/out.png'], note: 'rendered (eval stub)' },
}

export const CANVAS_SNAPSHOT_TOOL: StubToolDef = {
  name: 'canvas_snapshot',
  description: 'Read the current CATIMATION canvas (shapes, selection, asset paths). Use to inspect what is on the canvas.',
  inputSchema: { type: 'object', properties: {} },
  cannedResult: { shapes: [], selection: [], note: 'empty canvas (eval stub)' },
}

/** The standard multi-tool stub the routing scenarios expose. */
export const CATIMATION_TOOLS: StubToolDef[] = [ASK_USER_TOOL, GENERATE_IMAGE_TOOL, CANVAS_SNAPSHOT_TOOL]
