import {
  type GatewaySettings,
  gatewaySettingsPatchSchema,
  type OwnerNotices,
  ownerNoticesSchema,
} from '@jian/contracts';
import { eq } from 'drizzle-orm';
import { gatewayTimeZone } from '../core/time-zone.js';
import type { Store } from '../storage/database.js';
import { gatewaySettings } from '../storage/schema.js';

/** Settings of the whole installation: what every profile shares, such as its time zone. */
export class Settings {
  constructor(
    private readonly store: Store,
    private readonly configuredTimeZone?: string,
  ) {}

  private async saved(key: string): Promise<unknown> {
    const [row] = await this.store.db
      .select()
      .from(gatewaySettings)
      .where(eq(gatewaySettings.key, key))
      .limit(1);

    return row?.value;
  }

  private async save(key: string, value: unknown) {
    await this.store.db
      .insert(gatewaySettings)
      .values({ key, value })
      .onConflictDoUpdate({
        target: gatewaySettings.key,
        set: { value, updatedAt: new Date() },
      });
  }

  async read(): Promise<GatewaySettings> {
    const ownerNotices = await this.ownerNotices();

    // The environment wins without deleting a previously saved value, so removing the variable
    // restores the old setting during a rollback.
    if (this.configuredTimeZone) {
      return { timeZone: this.configuredTimeZone, timeZoneSource: 'setting', ownerNotices };
    }
    const saved = await this.saved('timeZone');
    const chosen = typeof saved === 'string' ? saved : undefined;

    return chosen
      ? { timeZone: chosen, timeZoneSource: 'setting', ownerNotices }
      : { timeZone: gatewayTimeZone(), timeZoneSource: 'host', ownerNotices };
  }

  /** The zone agents read the time in and schedules default to. */
  async timeZone() {
    return (await this.read()).timeZone;
  }

  /** Where the gateway's notices to the owner go; see `ownerNoticesSchema`. */
  async ownerNotices(): Promise<OwnerNotices> {
    const parsed = ownerNoticesSchema.safeParse(await this.saved('ownerNotices'));

    return parsed.success ? parsed.data : 'panel_and_channel';
  }

  async update(input: unknown) {
    const { timeZone, ownerNotices } = gatewaySettingsPatchSchema.parse(input);

    if (timeZone === null) {
      await this.store.db.delete(gatewaySettings).where(eq(gatewaySettings.key, 'timeZone'));
    } else if (timeZone !== undefined) {
      await this.save('timeZone', timeZone);
    }

    if (ownerNotices) await this.save('ownerNotices', ownerNotices);

    return this.read();
  }
}
