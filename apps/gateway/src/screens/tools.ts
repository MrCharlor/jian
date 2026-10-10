import { basename, isAbsolute } from 'node:path';
import {
  type Run,
  screenInventoryInputSchema,
  screenListQuerySchema,
  screenSheetInputSchema,
} from '@jian/contracts';
import { type ToolSet, tool } from 'ai';
import { z } from 'zod';
import { openToRead } from '../agent/workspace.js';
import { imageType, type Screens } from './service.js';

/** The largest print read from a file: what fits the contract's base64 limit. */
const PRINT_BYTES = 6_000_000;

const SOURCES =
  'Nothing is a fact without a source: mark each line screen (seen on the screen) or code (read in the code). What you did not confirm goes in questions, never in today or requirements.';

/** Reads a print the agent saved on the machine, held to its workspace like send_file. */
async function readPrint(profileId: string, path: string, name?: string) {
  if (!isAbsolute(path)) throw new Error('Use an absolute path for a print');

  const handle = await openToRead(profileId, path);

  try {
    const info = await handle.stat();

    if (!info.isFile()) throw new Error(`${path} is not a file`);
    if (info.size > PRINT_BYTES) throw new Error(`${path} is over 6 MB`);

    const bytes = await handle.readFile();
    const contentType = imageType(bytes);

    if (!contentType) throw new Error(`${path} is not a PNG, JPEG or WebP image`);

    return { name: name ?? basename(path), contentType, data: bytes.toString('base64') };
  } finally {
    await handle.close();
  }
}

/** The map of an application's screens: listed from the code and menu, then mapped one by one. */
export function screenTools(
  screens: Pick<Screens, 'list' | 'saveInventory' | 'get' | 'writeSheet' | 'attachPrints'>,
  run: Run,
): ToolSet {
  return {
    list_screens: tool({
      description:
        'List the screens mapped for an application: route, menu path, title, proposed squad, state (listed, mapping, draft, reviewed, published) and how many prints each has. Filter by application slug and state.',
      inputSchema: screenListQuerySchema,
      execute: async (query) =>
        (await screens.list(query)).map(
          ({ id, application, route, menuPath, title, squad, state, prints }) => ({
            id,
            application,
            route,
            menuPath,
            title,
            squad,
            state,
            prints: prints.length,
          }),
        ),
    }),
    save_screen_inventory: tool({
      description:
        'Record the list of screens of an application, from its routes in the code and its menu: route, menu path (e.g. "Cadastros > Cores"), title, and the squad you propose when the code or the board shows it. A known route is updated, a new one is listed; nothing is removed and no sheet is touched, so send the whole list or a part, as often as needed. The squad is a proposal: the owner decides.',
      inputSchema: screenInventoryInputSchema,
      execute: async (input) => screens.saveInventory(input),
    }),
    read_screen: tool({
      description:
        'Read one screen whole: route, menu path, state, the names of its prints, and its sheet (today, inferred requirements, questions, problems, each line with its source).',
      inputSchema: z.object({ id: z.uuid() }),
      execute: async ({ id }) => screens.get(id),
    }),
    write_screen_sheet: tool({
      description: `Write the sheet of a screen after walking through it without saving anything: today (what the screen does, as seen), requirements (what that behaviour suggests was asked), questions (what you could not confirm) and problems (what is wrong). ${SOURCES} The screen becomes a draft for the owner to review. Attach prints you saved on the machine by absolute path (PNG, JPEG or WebP); one with the same name replaces the old one.`,
      inputSchema: screenSheetInputSchema.extend({
        id: z.uuid(),
        prints: z
          .array(
            z.strictObject({
              path: z.string().min(1).max(4096),
              name: z.string().trim().min(1).max(120).optional(),
            }),
          )
          .max(6)
          .optional(),
      }),
      execute: async ({ id, prints, ...sheet }) => {
        // Read before writing anything: a bad path fails the call and leaves the sheet as it was.
        const files = await Promise.all(
          (prints ?? []).map((print) => readPrint(run.profileId, print.path, print.name)),
        );
        const written = await screens.writeSheet(id, sheet);

        return files.length ? screens.attachPrints(id, { prints: files }) : written;
      },
    }),
  };
}
