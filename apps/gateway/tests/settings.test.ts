import { expect, it } from 'vitest';
import { Settings } from '../src/settings/service.js';
import { testServices } from './helpers/services.js';

it('prefers the configured zone without discarding a saved zone needed for rollback', async () => {
  const services = await testServices(undefined, undefined, 'Asia/Tokyo');
  await services.settings.update({ timeZone: 'America/Sao_Paulo' });

  expect(await services.settings.read()).toEqual({
    timeZone: 'Asia/Tokyo',
    timeZoneSource: 'setting',
  });
  expect(await new Settings(services.store).timeZone()).toBe('America/Sao_Paulo');
});
