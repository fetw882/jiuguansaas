import { test, expect } from '@playwright/test';

test('Backgrounds list, upload and thumbnail', async ({ request, baseURL }) => {
  // Register
  const reg = await request.post(baseURL + '/api/auth/register', { data: { email: 'bg-e2e@test', password: 'x', card: 'AAAA-BBBB' } });
  expect(reg.ok()).toBeTruthy();
  const cookie = reg.headers()['set-cookie'] || '';

  // List defaults
  const list1 = await request.post(baseURL + '/api/backgrounds/all', { data: {} });
  expect(list1.ok()).toBeTruthy();
  const data1 = await list1.json();
  expect(Array.isArray(data1.images)).toBeTruthy();

  // Upload one
  const file = Buffer.from('PNG');
  const up = await request.post(baseURL + '/api/backgrounds/upload', {
    headers: { cookie },
    multipart: { avatar: { name: 'bg-e2e.png', mimeType: 'image/png', buffer: file } },
  });
  expect(up.ok()).toBeTruthy();

  // List again should include managed
  const list2 = await request.post(baseURL + '/api/backgrounds/all', { data: {} });
  const data2 = await list2.json();
  expect(data2.images.some((n: string) => n.includes('bg-e2e'))).toBeTruthy();

  // Thumbnail default 200
  const th = await request.get(baseURL + '/thumbnail?file=' + encodeURIComponent('/st/default/content/__transparent.png'));
  expect(th.status()).toBe(200);
});

