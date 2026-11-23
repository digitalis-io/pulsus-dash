/**
 * Annotations through the annotations API for the e2e specs (plan #64 Part C §3.4): create one,
 * delete one, and delete every one a spec created.
 */
import { expect, type APIRequestContext } from '@playwright/test';

export const ANNOTATIONS_API = '/api/dash/v1/annotations';

export interface AnnotationInput {
  at: number;
  kind: 'deploy' | 'config' | 'flag' | 'annotation';
  text: string;
  end_at?: number;
  tags?: string[];
}

/** Creates an annotation (201) and returns its id. */
export async function createAnnotation(
  request: APIRequestContext,
  a: AnnotationInput,
): Promise<string> {
  const created = await request.post(ANNOTATIONS_API, { data: a });
  expect(created.status()).toBe(201);
  return ((await created.json()) as { id: string }).id;
}

/** Deletes an annotation: 204, or 404 when it is already gone. */
export async function deleteAnnotation(request: APIRequestContext, id: string): Promise<void> {
  const r = await request.delete(`${ANNOTATIONS_API}/${id}`);
  expect([204, 404]).toContain(r.status());
}

export async function deleteAnnotations(
  request: APIRequestContext,
  ids: readonly string[],
): Promise<void> {
  for (const id of ids) await deleteAnnotation(request, id);
}
