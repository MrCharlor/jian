import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileNameOf, type InlineMedia, mediaMimeOf } from '@jian/contracts';
import type { ModelMessage } from 'ai';
import { strToU8, zipSync } from 'fflate';
import { expect, it } from 'vitest';
import { listDeliveries } from '../src/channels/repository.js';
import { Channels } from '../src/channels/service.js';
import { TelegramChannel } from '../src/channels/telegram.js';
import { outgoingMedia } from '../src/channels/whatsapp/driver.js';
import { readWhatsAppContent } from '../src/channels/whatsapp/media.js';
import { officeText } from '../src/media/documents.js';
import { mediaIdsIn } from '../src/media/repository.js';
import { testServices } from './helpers/services.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const base64 = (text: string | Uint8Array) => Buffer.from(text).toString('base64');

const docx = () =>
  zipSync({
    'word/document.xml': strToU8(
      '<w:document><w:body><w:p><w:r><w:t>Invoice 42</w:t></w:r></w:p><w:p><w:r><w:t>Total:</w:t></w:r><w:r><w:tab/><w:t>R$ 1.200 &amp; taxes</w:t></w:r></w:p></w:body></w:document>',
    ),
  });

const xlsx = () =>
  zipSync({
    'xl/workbook.xml': strToU8(
      '<workbook><sheets><sheet name="Budget" sheetId="1"/></sheets></workbook>',
    ),
    'xl/sharedStrings.xml': strToU8(
      '<sst><si><t>Item</t></si><si><t>Cost</t></si><si><t>Rent</t></si></sst>',
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>900</v></c></row></sheetData></worksheet>',
    ),
  });

it('stores a file under its reported type, its extension, or as bytes', () => {
  expect(mediaMimeOf('application/pdf; charset=binary')).toBe('application/pdf');
  expect(mediaMimeOf('application/octet-stream', 'contract.docx')).toBe(DOCX);
  expect(mediaMimeOf(undefined, 'photo.JPG')).toBe('image/jpeg');
  expect(mediaMimeOf('application/x-unknown', 'data.bin')).toBe('application/octet-stream');
  expect(fileNameOf(XLSX)).toBe('file.xlsx');
  expect(fileNameOf(XLSX, 'budget.xlsx')).toBe('budget.xlsx');
});

it('reads the text of a Word document and a spreadsheet', () => {
  expect(officeText(DOCX, Buffer.from(docx()))).toBe('Invoice 42\nTotal:\tR$ 1.200 & taxes');
  expect(officeText(XLSX, Buffer.from(xlsx()))).toBe('## Budget\nItem\tCost\nRent\t900');
  expect(() => officeText(DOCX, Buffer.from('not a zip'))).toThrow();
});

it('receives any WhatsApp document with its name, caption and type', async () => {
  const parsed = await readWhatsAppContent(
    {
      key: { id: 'doc' },
      message: {
        documentWithCaptionMessage: {
          message: {
            documentMessage: {
              mimetype: 'application/octet-stream',
              fileName: 'contract.docx',
              caption: 'Please review',
              fileLength: 3,
            },
          },
        },
      },
    },
    async () => Buffer.from('doc'),
  );

  expect(parsed.text).toBe('Please review');
  expect(parsed.media).toEqual([{ mimeType: DOCX, data: base64('doc'), name: 'contract.docx' }]);

  const bare = await readWhatsAppContent(
    {
      key: { id: 'zip' },
      message: { documentMessage: { mimetype: 'application/zip', fileName: 'photos.zip' } },
    },
    async () => Buffer.from('zip'),
  );

  expect(bare.text).toBe('[File: photos.zip]');
});

it('sends a document on WhatsApp under its name, and a voice note as one', () => {
  expect(
    outgoingMedia({ mimeType: 'application/pdf', data: base64('pdf'), name: 'report.pdf' }, 'Here'),
  ).toMatchObject({
    document: Buffer.from('pdf'),
    fileName: 'report.pdf',
    mimetype: 'application/pdf',
    caption: 'Here',
  });
  expect(outgoingMedia({ mimeType: 'text/csv', data: base64('a,b') }, '')).toMatchObject({
    fileName: 'file.csv',
  });
  expect(outgoingMedia({ mimeType: 'audio/ogg', data: base64('ogg') }, '')).toMatchObject({
    ptt: true,
  });
});

it('downloads a Telegram document sent without caption, and sends one back', async () => {
  const telegram = new TelegramChannel();
  const payload = {
    update_id: 7,
    message: {
      from: { id: 11, first_name: 'Rowan' },
      chat: { id: 11, type: 'private' },
      document: { file_id: 'file-1', file_name: 'budget.xlsx', mime_type: XLSX, file_size: 3 },
    },
  };

  expect(telegram.receive(payload)?.text).toBe('[File: budget.xlsx]');

  const called: string[] = [];
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    const address = String(url);

    called.push(address.replace(/bot[^/]+/, 'bot<token>'));
    if (address.endsWith('/getFile'))
      return Response.json({
        ok: true,
        result: { file_id: 'file-1', file_path: 'documents/file_1.xlsx' },
      });
    if (address.includes('/file/')) return new Response('xls');

    const form = init?.body as FormData;
    const file = form.get('document') as File;

    expect(file.name).toBe('budget.xlsx');
    expect(form.get('caption')).toBe('Updated');

    return Response.json({ ok: true, result: { message_id: 90 } });
  }) as typeof fetch;
  const context = {
    channelId: 'telegram',
    credential: '123:synthetic_token',
    fetch: fetcher,
    signal: AbortSignal.timeout(1000),
  };

  expect(await telegram.download(payload, context)).toEqual({
    media: [{ mimeType: XLSX, data: base64('xls'), name: 'budget.xlsx' }],
  });

  const sent = await telegram.send(
    {
      chatId: '11',
      text: 'Updated',
      media: { mimeType: XLSX, data: base64('xls'), name: 'budget.xlsx' },
    },
    context,
  );

  expect(sent).toEqual({ status: 'sent', remoteMessageIds: [90] });
  expect(called.at(-1)).toBe('https://api.telegram.org/bot<token>/sendDocument');
});

it('tells the Telegram sender when a file is over 16 MB, without downloading it', async () => {
  const telegram = new TelegramChannel();
  const result = await telegram.download(
    {
      update_id: 8,
      message: {
        from: { id: 11 },
        chat: { id: 11 },
        video: { file_id: 'big', file_size: 40 * 1024 * 1024 },
      },
    },
    {
      channelId: 'telegram',
      credential: '123:synthetic_token',
      fetch: (async () => {
        throw new Error('must not download');
      }) as typeof fetch,
      signal: AbortSignal.timeout(1000),
    },
  );

  expect(result.note).toContain('exceeds 16 MB');
});

async function conversation(media: InlineMedia[]) {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Files',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const channels = new Channels(services, fetch);
  const channel = await channels.connect(profile.id, { type: 'api' });

  await channels.receive(channel.id, {
    type: 'api',
    headers: { 'x-jian-channel-token': channel.webhookToken },
    payload: { actorId: 'rowan', chatId: 'rowan', text: 'Here you go', requestKey: 'files', media },
  });

  const [contact] = await channels.contacts(profile.id);
  if (!contact) throw new Error('Missing contact');
  await channels.approveContact(profile.id, contact.id);

  const [run] = await services.runs.recent(profile.id);
  if (!run) throw new Error('Missing run');

  return { services, profile, run };
}

it('gives the agent the text of an Office file and names a format it cannot read', async () => {
  const f = await conversation([
    { mimeType: XLSX, data: base64(xlsx()), name: 'budget.xlsx' },
    { mimeType: 'application/zip', data: base64('zip'), name: 'photos.zip' },
  ]);
  const messages: ModelMessage[] = [{ role: 'user', content: f.run.input }];

  await f.services.media.prepare(messages, f.run, AbortSignal.timeout(1000));

  const text = JSON.stringify(messages[0]?.content);

  expect(text).toContain('(budget.xlsx)');
  expect(text).toContain('Rent\\t900');
  expect(text).toContain('photos.zip): application/zip, 3 bytes. Its content cannot be read here.');
});

it('sends a file the agent writes once, with its caption, however often the call is retried', async () => {
  const f = await conversation([]);
  const send = f.services.media.tools(f.run).send_file;
  if (!send?.execute) throw new Error('Missing send_file');
  const call = { toolCallId: 'send-1', messages: [], context: {} };
  const input = { content: 'item,cost\nrent,900\n', name: 'budget.csv', caption: 'This month' };

  const first = await send.execute(input, call);
  const again = await send.execute(input, call);

  expect(again).toEqual(first);
  expect(first).toMatchObject({ status: 'queued for delivery' });

  const deliveries = (await listDeliveries(f.services.store.db, f.profile.id)).filter(
    (item) => item.mediaId,
  );
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0]?.notice).toBe('This month');

  const stored = await f.services.media.read(f.profile.id, (first as { mediaId: string }).mediaId);
  expect(stored).toMatchObject({ mimeType: 'text/csv', name: 'budget.csv' });

  const shown = await f.services.sessions.messages(f.profile.id, f.run.sessionId, 20);
  expect(shown.filter((message) => mediaIdsIn(message.content).includes(stored.id))).toHaveLength(
    1,
  );

  await expect(
    send.execute({ content: 'x', name: 'report.pdf' }, { ...call, toolCallId: 'pdf' }),
  ).rejects.toThrow('not a text format');
  // Without the machine there is no path to read and no disk to save to.
  await expect(
    send.execute({ path: '/etc/hosts' }, { ...call, toolCallId: 'path' }),
  ).rejects.toThrow('cannot read files on the machine');
  expect(f.services.media.tools(f.run).save_attachment).toBeUndefined();
});

it('saves an attachment to disk and sends a file from it when the machine is on', async () => {
  const f = await conversation([
    { mimeType: 'application/zip', data: base64('zip'), name: 'photos.zip' },
  ]);
  const run = { ...f.run, profile: { ...f.run.profile, allowShell: true } };
  const tools = f.services.media.tools(run);
  const [mediaId] = mediaIdsIn(run.input);
  if (!mediaId) throw new Error('Missing media');
  const folder = await mkdtemp(join(tmpdir(), 'jian-files-'));
  const call = { messages: [], context: {} };

  try {
    const path = join(folder, 'in', 'photos.zip');

    await tools.save_attachment?.execute?.(
      { mediaId, path, overwrite: false },
      { ...call, toolCallId: 'save' },
    );
    expect(await readFile(path, 'utf8')).toBe('zip');
    await expect(
      tools.save_attachment?.execute?.(
        { mediaId, path, overwrite: false },
        { ...call, toolCallId: 'again' },
      ),
    ).rejects.toThrow('already there');

    const sent = (await tools.send_file?.execute?.({ path }, { ...call, toolCallId: 'send' })) as {
      mediaId: string;
    };
    expect(await f.services.media.read(f.profile.id, sent.mediaId)).toMatchObject({
      name: 'photos.zip',
      mimeType: 'application/zip',
      data: base64('zip'),
    });

    // A call with every field filled, placeholders in the ones not meant, as some models make.
    const filled = {
      path,
      mediaId: '00000000-0000-0000-0000-000000000000',
      content: 'placeholder',
      name: 'photos.zip',
      sessionId: run.sessionId,
    };
    await expect(
      tools.send_file?.execute?.(filled, { ...call, toolCallId: 'filled' }),
    ).rejects.toThrow('name the one to use in source');
    const chosen = (await tools.send_file?.execute?.(
      { ...filled, source: 'path' },
      { ...call, toolCallId: 'chosen' },
    )) as { mediaId: string };
    expect(await f.services.media.read(f.profile.id, chosen.mediaId)).toMatchObject({
      name: 'photos.zip',
      data: base64('zip'),
    });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
