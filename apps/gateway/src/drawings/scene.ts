import { createCipheriv, createDecipheriv, randomBytes, randomInt } from 'node:crypto';
import { z } from 'zod';

/**
 * A diagram as an agent describes it: boxes on a grid and the arrows between them. The layout
 * is computed here, so the agent picks the column and row of each box and never a coordinate.
 */
export const diagramColorSchema = z.enum(['blue', 'green', 'yellow', 'red', 'gray', 'purple']);

export const diagramSpecSchema = z.object({
  heading: z.string().max(200).optional(),
  nodes: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        label: z.string().min(1).max(200),
        shape: z.enum(['box', 'diamond', 'ellipse', 'note']).default('box'),
        col: z.number().int().min(0).max(30),
        row: z.number().int().min(0).max(30),
        color: diagramColorSchema.default('blue'),
        dashed: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(80),
  edges: z
    .array(
      z.object({
        from: z.string().min(1).max(40),
        to: z.string().min(1).max(40),
        label: z.string().max(80).optional(),
        color: diagramColorSchema.optional(),
        dashed: z.boolean().default(false),
      }),
    )
    .max(150)
    .default([]),
});

export type DiagramSpec = z.input<typeof diagramSpecSchema>;

const COLORS: Record<z.infer<typeof diagramColorSchema>, { stroke: string; fill: string }> = {
  blue: { stroke: '#1971c2', fill: '#e7f5ff' },
  green: { stroke: '#2f9e44', fill: '#ebfbee' },
  yellow: { stroke: '#f08c00', fill: '#fff9db' },
  red: { stroke: '#e03131', fill: '#fff5f5' },
  gray: { stroke: '#868e96', fill: '#f8f9fa' },
  purple: { stroke: '#9c36b5', fill: '#f8f0fc' },
};

const CELL_W = 280;
const CELL_H = 230;
const BOX_W = 210;
const BOX_H = 95;
const FONT = 20;
/** Excalifont, the hand-drawn face of current Excalidraw. */
const FAMILY = 5;
const TOP = 90;

type Element = Record<string, unknown> & { id: string; version: number };

const newId = () => randomBytes(10).toString('base64url');

function base(type: string, x: number, y: number, width: number, height: number, stroke: string) {
  return {
    id: newId(),
    type,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: stroke,
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null as null | { type: number },
    seed: randomInt(1, 2 ** 31 - 1),
    version: 1,
    versionNonce: randomInt(1, 2 ** 31 - 1),
    isDeleted: false,
    boundElements: [] as Array<{ type: string; id: string }>,
    updated: Date.now(),
    link: null,
    locked: false,
  };
}

function text(
  content: string,
  x: number,
  y: number,
  color: string,
  container?: string,
  size = FONT,
) {
  const lines = content.split('\n');
  const width = Math.max(...lines.map((line) => line.length)) * size * 0.55;
  const height = lines.length * size * 1.25;

  return {
    ...base('text', x - width / 2, y - height / 2, width, height, color),
    text: content,
    originalText: content,
    fontSize: size,
    fontFamily: FAMILY,
    textAlign: 'center',
    verticalAlign: 'middle',
    containerId: container ?? null,
    autoResize: true,
    lineHeight: 1.25,
  };
}

/** Breaks a label so it fits the box: about 17 characters a line at this size. */
function wrap(label: string, width: number) {
  const perLine = Math.max(8, Math.floor(width / (FONT * 0.55)) - 2);

  return label
    .split('\n')
    .flatMap((paragraph) => {
      const lines: string[] = [];
      let line = '';

      for (const word of paragraph.split(/\s+/)) {
        if (line && `${line} ${word}`.length > perLine) {
          lines.push(line);
          line = word;
        } else {
          line = line ? `${line} ${word}` : word;
        }
      }

      return [...lines, line];
    })
    .join('\n');
}

/** The elements of the diagram, ready to be stored as an Excalidraw scene. */
export function diagramElements(input: DiagramSpec): Element[] {
  const spec = diagramSpecSchema.parse(input);
  const elements: Element[] = [];
  const boxes = new Map<
    string,
    Element & { x: number; y: number; width: number; height: number }
  >();

  if (spec.heading) {
    const heading = text(spec.heading, 0, 0, '#1e1e1e', undefined, 32);
    heading.x = 0;
    heading.y = 0;
    elements.push(heading);
  }

  for (const node of spec.nodes) {
    const color = COLORS[node.color];
    const width = node.shape === 'diamond' ? BOX_W * 0.95 : BOX_W;
    const label = wrap(node.label, node.shape === 'diamond' ? width * 0.6 : width - 20);
    const lines = label.split('\n').length;
    const height = Math.max(node.shape === 'diamond' ? 115 : BOX_H, lines * FONT * 1.25 + 40);
    const x = node.col * CELL_W + (CELL_W - width) / 2;
    const y = TOP + node.row * CELL_H + (CELL_H - height) / 2;
    const shape = {
      ...base(
        node.shape === 'box' || node.shape === 'note' ? 'rectangle' : node.shape,
        x,
        y,
        width,
        height,
        color.stroke,
      ),
      backgroundColor: color.fill,
      strokeStyle: node.dashed || node.shape === 'note' ? 'dashed' : 'solid',
      roundness: node.shape === 'diamond' ? { type: 2 } : { type: 3 },
    };
    const caption = text(label, x + width / 2, y + height / 2, color.stroke, shape.id);

    shape.boundElements.push({ type: 'text', id: caption.id });
    elements.push(shape, caption);
    boxes.set(node.id, shape);
  }

  for (const edge of spec.edges) {
    const from = boxes.get(edge.from);
    const to = boxes.get(edge.to);

    if (!from || !to) continue;

    const fc = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
    const tc = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
    const dx = tc.x - fc.x;
    const dy = tc.y - fc.y;
    const across = Math.abs(dx) >= Math.abs(dy);
    // Leave from the side facing the target and arrive on the side facing the source.
    const start = across
      ? { x: dx > 0 ? from.x + from.width : from.x, y: fc.y }
      : { x: fc.x, y: dy > 0 ? from.y + from.height : from.y };
    const end = across
      ? { x: dx > 0 ? to.x : to.x + to.width, y: tc.y }
      : { x: tc.x, y: dy > 0 ? to.y : to.y + to.height };
    const gap = 6;
    const s = across
      ? { x: start.x + Math.sign(dx) * gap, y: start.y }
      : { x: start.x, y: start.y + Math.sign(dy) * gap };
    const e = across
      ? { x: end.x - Math.sign(dx) * gap, y: end.y }
      : { x: end.x, y: end.y - Math.sign(dy) * gap };
    const points: Array<[number, number]> =
      across && s.y !== e.y
        ? [
            [0, 0],
            [(e.x - s.x) / 2, 0],
            [(e.x - s.x) / 2, e.y - s.y],
            [e.x - s.x, e.y - s.y],
          ]
        : !across && s.x !== e.x
          ? [
              [0, 0],
              [0, (e.y - s.y) / 2],
              [e.x - s.x, (e.y - s.y) / 2],
              [e.x - s.x, e.y - s.y],
            ]
          : [
              [0, 0],
              [e.x - s.x, e.y - s.y],
            ];
    const stroke = edge.color ? COLORS[edge.color].stroke : '#1e1e1e';
    const arrow = {
      ...base('arrow', s.x, s.y, Math.abs(e.x - s.x), Math.abs(e.y - s.y), stroke),
      strokeStyle: edge.dashed ? 'dashed' : 'solid',
      points,
      lastCommittedPoint: null,
      startBinding: { elementId: from.id, focus: 0, gap },
      endBinding: { elementId: to.id, focus: 0, gap },
      startArrowhead: null,
      endArrowhead: 'arrow',
      elbowed: false,
    };

    (from.boundElements as Array<{ type: string; id: string }>).push({
      type: 'arrow',
      id: arrow.id,
    });
    (to.boundElements as Array<{ type: string; id: string }>).push({ type: 'arrow', id: arrow.id });
    elements.push(arrow);

    if (edge.label) {
      const middle = points[Math.floor(points.length / 2)] ?? [0, 0];
      const before = points[Math.floor(points.length / 2) - 1] ?? [0, 0];
      const label = text(
        edge.label,
        s.x + (middle[0] + before[0]) / 2,
        s.y + (middle[1] + before[1]) / 2,
        stroke,
        arrow.id,
        16,
      );

      arrow.boundElements.push({ type: 'text', id: label.id });
      elements.push(label);
    }
  }

  return elements;
}

/** The version the board compares to decide which copy of a room is newer. */
export const sceneVersion = (elements: Element[]) =>
  elements.reduce((sum, element) => sum + element.version, 0);

/** A room address: 20 hex characters, and a 128-bit AES-GCM key as Excalidraw writes it. */
export function newRoom() {
  return {
    roomId: randomBytes(10).toString('hex'),
    roomKey: randomBytes(16).toString('base64url'),
  };
}

/** A room as the board stores it: the scene version, the IV, then the encrypted elements. */
export function encryptRoom(elements: Element[], roomKey: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-128-gcm', Buffer.from(roomKey, 'base64url'), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(elements), 'utf8'), cipher.final()]);
  const version = Buffer.alloc(4);

  version.writeUInt32BE(sceneVersion(elements) % 2 ** 32);

  return Buffer.concat([version, iv, body, cipher.getAuthTag()]);
}

export function decryptRoom(stored: Buffer, roomKey: string): Element[] {
  const iv = stored.subarray(4, 16);
  const tag = stored.subarray(stored.length - 16);
  const decipher = createDecipheriv('aes-128-gcm', Buffer.from(roomKey, 'base64url'), iv);

  decipher.setAuthTag(tag);

  return JSON.parse(
    Buffer.concat([
      decipher.update(stored.subarray(16, stored.length - 16)),
      decipher.final(),
    ]).toString('utf8'),
  );
}
