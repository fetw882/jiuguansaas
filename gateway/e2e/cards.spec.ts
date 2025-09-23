import { test, expect } from '@playwright/test';

test('Export PNG card and import back', async ({ request, baseURL }) => {
  const reg = await request.post(baseURL + '/api/auth/register', { data: { email: 'card-e2e@test', password: 'x', card: 'AAAA-BBBB' } });
  expect(reg.ok()).toBeTruthy();
  const cookie = reg.headers()['set-cookie'] || '';

  // Create character
  const cr = await request.post(baseURL + '/api/characters/create', { headers: { cookie }, multipart: { name: 'E2E-Card' } });
  expect(cr.ok()).toBeTruthy();

  const list = await request.post(baseURL + '/api/characters/all', { headers: { cookie }, data: {} });
  const chars = await list.json();
  const av = chars[0].avatar;

  const png = await request.post(baseURL + '/api/characters/export-png', { headers: { cookie }, data: { avatar_url: av } });
  expect(png.ok()).toBeTruthy();
  const buf = Buffer.from(await png.body().arrayBuffer());

  const imp = await request.post(baseURL + '/api/characters/import-card', { headers: { cookie }, multipart: { file: { name: 'card.png', mimeType: 'image/png', buffer: buf } } });
  expect(imp.ok()).toBeTruthy();
});

