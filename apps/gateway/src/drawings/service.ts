import { randomUUID } from 'node:crypto';
import { type Drawing, drawingInputSchema } from '@jian/contracts';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Clock } from '../core/clock.js';
import { assertFound, GatewayError } from '../core/errors.js';
import { drawCookie } from '../draw/routes.js';
import type { Store } from '../storage/database.js';
import { drawings, pautas } from '../storage/schema.js';
import { decryptRoom, diagramElements, diagramSpecSchema, encryptRoom, newRoom } from './scene.js';

export const drawInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  pautaId: z.string().uuid().optional(),
  /** A drawing an agent made before: it is drawn again in the same room, at the same link. */
  drawingId: z.string().uuid().optional(),
  diagram: diagramSpecSchema,
});

export type DrawInput = z.input<typeof drawInputSchema>;

/** Where the board stores rooms, reached from the gateway with a cookie it signs itself. */
export type RoomStore = {
  get(roomId: string): Promise<Buffer | undefined>;
  put(roomId: string, body: Buffer): Promise<void>;
};

export function boardRooms(internalUrl: string, token: string, clock: Clock): RoomStore {
  const address = (roomId: string) => `${internalUrl}/storage/api/v2/rooms/${roomId}`;
  const headers = () => ({ cookie: drawCookie(token, clock()) });

  return {
    async get(roomId) {
      const response = await fetch(address(roomId), { headers: headers() });

      if (response.status === 404) return undefined;
      if (!response.ok) throw new GatewayError(502, `The board answered ${response.status}`);

      return Buffer.from(await response.arrayBuffer());
    },
    async put(roomId, body) {
      const response = await fetch(address(roomId), {
        method: 'PUT',
        headers: { ...headers(), 'content-type': 'application/octet-stream' },
        body: new Uint8Array(body),
      });

      if (!response.ok) throw new GatewayError(502, `The board answered ${response.status}`);
    },
  };
}

/** The owner's drawings, and the diagrams agents draw on the board for them. */
export class Drawings {
  constructor(
    private readonly store: Store,
    private readonly board?: { publicUrl: string; rooms: RoomStore },
    private readonly clock: Clock = Date.now,
  ) {}

  async list(): Promise<Drawing[]> {
    const rows = await this.store.db
      .select({ drawing: drawings, pauta: pautas.title })
      .from(drawings)
      .leftJoin(pautas, eq(pautas.id, drawings.pautaId))
      .orderBy(desc(drawings.updatedAt))
      .limit(300);

    return rows.map(({ drawing, pauta }) => ({
      id: drawing.id,
      title: drawing.title,
      url: drawing.url,
      ...(drawing.pautaId ? { pautaId: drawing.pautaId } : {}),
      ...(pauta ? { pauta } : {}),
      ...(drawing.createdBy ? { createdBy: drawing.createdBy } : {}),
      editable: Boolean(drawing.roomId && drawing.roomKey),
      createdAt: drawing.createdAt.toISOString(),
      updatedAt: drawing.updatedAt.toISOString(),
    }));
  }

  private async one(id: string) {
    return assertFound(
      (await this.list()).find((item) => item.id === id),
      'Drawing',
    );
  }

  /** A link the owner saved, such as one exported from the board. */
  async add(input: unknown): Promise<Drawing> {
    const data = drawingInputSchema.parse(input);
    const id = randomUUID();
    const now = new Date(this.clock());

    await this.store.db.insert(drawings).values({
      id,
      title: data.title,
      url: data.url,
      pautaId: data.pautaId ?? null,
      createdAt: now,
      updatedAt: now,
    });

    return this.one(id);
  }

  async remove(id: string): Promise<Drawing> {
    const drawing = await this.one(id);

    await this.store.db.delete(drawings).where(eq(drawings.id, id));

    return drawing;
  }

  /**
   * Draws the diagram in a room of the board, so the owner opens it already editable and every
   * change is kept. Drawing again replaces what the agent drew before, in the same room.
   */
  async draw(input: DrawInput, by?: { profileId: string; name: string }): Promise<Drawing> {
    if (!this.board) throw new GatewayError(503, 'No drawing board on this gateway');

    const data = drawInputSchema.parse(input);
    const now = new Date(this.clock());
    const fresh = diagramElements(data.diagram);
    const [previous] = data.drawingId
      ? await this.store.db.select().from(drawings).where(eq(drawings.id, data.drawingId))
      : [];

    if (data.drawingId && !previous?.roomId) {
      throw new GatewayError(409, 'That drawing was not made by an agent, so it cannot be redrawn');
    }

    const room =
      previous?.roomId && previous.roomKey
        ? { roomId: previous.roomId, roomKey: previous.roomKey }
        : newRoom();
    const stored = previous ? await this.board.rooms.get(room.roomId) : undefined;
    // What was there stays as deleted, one version up, so open copies drop it too.
    const old = stored
      ? decryptRoom(stored, room.roomKey).map((element) => ({
          ...element,
          isDeleted: true,
          version: element.version + 1,
          updated: now.getTime(),
        }))
      : [];

    await this.board.rooms.put(room.roomId, encryptRoom([...old, ...fresh], room.roomKey));

    const url = `${this.board.publicUrl}/#room=${room.roomId},${room.roomKey}`;
    const id = previous?.id ?? randomUUID();

    if (previous) {
      await this.store.db
        .update(drawings)
        .set({
          title: data.title,
          spec: data.diagram,
          ...(data.pautaId ? { pautaId: data.pautaId } : {}),
          updatedAt: now,
        })
        .where(eq(drawings.id, id));
    } else {
      await this.store.db.insert(drawings).values({
        id,
        title: data.title,
        url,
        pautaId: data.pautaId ?? null,
        roomId: room.roomId,
        roomKey: room.roomKey,
        spec: data.diagram,
        createdBy: by?.name ?? null,
        profileId: by?.profileId ?? null,
        createdAt: now,
        updatedAt: now,
      });
    }

    return this.one(id);
  }
}
