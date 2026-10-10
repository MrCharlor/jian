import type { Application, ApplicationFile } from '@jian/contracts';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Queryable } from '../storage/database.js';
import { applicationFiles, applications } from '../storage/schema.js';

type Row = typeof applications.$inferSelect;

export function toApplication(row: Row, files: number): Application {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    ...(row.url ? { url: row.url } : {}),
    ...(row.audience ? { audience: row.audience } : {}),
    platform: row.platform as Application['platform'],
    ...(row.source ? { source: row.source } : {}),
    ...(row.designUrl ? { designUrl: row.designUrl } : {}),
    version: row.version,
    files,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const fileCount = sql<number>`(select count(*) from ${applicationFiles} where ${applicationFiles.applicationId} = ${applications.id})`;

export async function listApplications(db: Queryable): Promise<Application[]> {
  const rows = await db
    .select({ row: applications, files: fileCount })
    .from(applications)
    .orderBy(asc(applications.name));

  return rows.map(({ row, files }) => toApplication(row, Number(files)));
}

export async function findApplication(db: Queryable, slug: string): Promise<Application | null> {
  const [found] = await db
    .select({ row: applications, files: fileCount })
    .from(applications)
    .where(eq(applications.slug, slug))
    .limit(1);

  return found ? toApplication(found.row, Number(found.files)) : null;
}

export async function insertApplication(
  db: Queryable,
  row: typeof applications.$inferInsert,
): Promise<void> {
  await db.insert(applications).values(row);
}

export async function updateApplication(
  db: Queryable,
  id: string,
  patch: Partial<typeof applications.$inferInsert>,
): Promise<void> {
  await db.update(applications).set(patch).where(eq(applications.id, id));
}

export async function deleteApplication(db: Queryable, id: string): Promise<void> {
  await db.delete(applications).where(eq(applications.id, id));
}

export async function listFiles(db: Queryable, applicationId: string): Promise<ApplicationFile[]> {
  const rows = await db
    .select({
      path: applicationFiles.path,
      contentType: applicationFiles.contentType,
      bytes: applicationFiles.bytes,
      updatedAt: applicationFiles.updatedAt,
    })
    .from(applicationFiles)
    .where(eq(applicationFiles.applicationId, applicationId))
    .orderBy(asc(applicationFiles.path));

  return rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() }));
}

export async function readFile(
  db: Queryable,
  applicationId: string,
  path: string,
): Promise<typeof applicationFiles.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(applicationFiles)
    .where(and(eq(applicationFiles.applicationId, applicationId), eq(applicationFiles.path, path)))
    .limit(1);

  return row ?? null;
}

export async function writeFile(
  db: Queryable,
  file: typeof applicationFiles.$inferInsert,
): Promise<void> {
  await db
    .insert(applicationFiles)
    .values(file)
    .onConflictDoUpdate({
      target: [applicationFiles.applicationId, applicationFiles.path],
      set: {
        contentType: file.contentType,
        encoding: file.encoding,
        content: file.content,
        bytes: file.bytes,
        updatedAt: file.updatedAt,
      },
    });
}

export async function deleteFile(db: Queryable, applicationId: string, path: string) {
  await db
    .delete(applicationFiles)
    .where(and(eq(applicationFiles.applicationId, applicationId), eq(applicationFiles.path, path)));
}
