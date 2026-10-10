import { describe, expect, it } from 'vitest';
import { decryptRoom } from '../src/drawings/scene.js';
import { Drawings, type RoomStore } from '../src/drawings/service.js';
import { testServices } from './helpers/services.js';

const flow = {
  heading: 'Sigma: do pedido à produção',
  nodes: [
    { id: 'pedido', label: 'PO\nPedido na Entrada', col: 0, row: 0, color: 'blue' as const },
    { id: 'teste', label: 'Tester testa os CAs', col: 1, row: 0, color: 'yellow' as const },
    {
      id: 'passou',
      label: 'Passou?',
      shape: 'diamond' as const,
      col: 1,
      row: 1,
      color: 'yellow' as const,
    },
    {
      id: 'prod',
      label: 'Produção',
      shape: 'ellipse' as const,
      col: 0,
      row: 1,
      color: 'green' as const,
    },
  ],
  edges: [
    { from: 'pedido', to: 'teste' },
    { from: 'teste', to: 'passou' },
    { from: 'passou', to: 'prod', label: 'passou', color: 'green' as const },
  ],
};

function memoryRooms() {
  const rooms = new Map<string, Buffer>();
  const store: RoomStore = {
    get: async (id) => rooms.get(id),
    put: async (id, body) => void rooms.set(id, body),
  };

  return { rooms, store };
}

describe('drawings', () => {
  it('draws a diagram in an editable room and redraws it at the same link', async () => {
    const services = await testServices();
    const { rooms, store } = memoryRooms();
    const drawings = new Drawings(services.store, {
      publicUrl: 'https://draw.example',
      rooms: store,
    });

    const drawn = await drawings.draw(
      { title: 'Fluxo da Sigma', diagram: flow },
      {
        profileId: (
          await services.profiles.createProfile({
            name: 'Otto',
            instructions: 'Help.',
            model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
          })
        ).id,
        name: 'Otto',
      },
    );
    const [, roomId, roomKey] = drawn.url.match(/#room=([0-9a-f]{20}),([\w-]{22})$/) ?? [];

    expect(drawn).toMatchObject({ title: 'Fluxo da Sigma', createdBy: 'Otto', editable: true });
    const elements = decryptRoom(rooms.get(roomId ?? '') as Buffer, roomKey ?? '');
    const types = elements.map((element) => element.type);
    expect(types.filter((type) => type === 'rectangle')).toHaveLength(2);
    expect(types).toContain('diamond');
    expect(types).toContain('ellipse');
    expect(types.filter((type) => type === 'arrow')).toHaveLength(3);
    const arrow = elements.find((element) => element.type === 'arrow') as Record<string, unknown>;
    expect(arrow.startBinding).toMatchObject({ elementId: expect.any(String) });

    const again = await drawings.draw({
      title: 'Fluxo da Sigma v2',
      drawingId: drawn.id,
      diagram: { nodes: [flow.nodes[0] as (typeof flow.nodes)[number]] },
    });
    const now = decryptRoom(rooms.get(roomId ?? '') as Buffer, roomKey ?? '');

    expect(again.url).toBe(drawn.url);
    expect(now.filter((element) => !element.isDeleted)).toHaveLength(2);
    expect(now.filter((element) => element.isDeleted).length).toBe(elements.length);
  });

  it('keeps a link the owner saved, and takes it off the list', async () => {
    const services = await testServices();
    const saved = await services.drawings.add({
      title: 'Mapa do Hardware',
      url: 'https://draw.example/#json=1,abc',
    });

    expect(saved).toMatchObject({ editable: false });
    await services.drawings.remove(saved.id);
    expect(await services.drawings.list()).toEqual([]);
    await expect(services.drawings.draw({ title: 'x', diagram: flow })).rejects.toThrow(
      'No drawing board',
    );
  });
});
