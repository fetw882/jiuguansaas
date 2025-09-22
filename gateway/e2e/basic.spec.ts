import { test, expect } from '@playwright/test';

test('Stage0: /st renders and injects scripts', async ({ page, baseURL }) => {
  await page.goto(baseURL + '/st');
  await expect(page.locator('script[src="/st-inject/observer.js"]')).toHaveCount(1);
});

test('Ping and JSON errors', async ({ request, baseURL }) => {
  const ping = await request.get(baseURL + '/api/ping');
  expect(ping.ok()).toBeTruthy();
  const unauth = await request.post(baseURL + '/api/characters/create');
  expect(unauth.status()).toBe(401);
  expect((await unauth.json()).error).toBeTruthy();
});

test('Auth + settings + character flow', async ({ request, baseURL }) => {
  const reg = await request.post(baseURL + '/api/auth/register', { data: { email: 'e2e@test', password: 'x', card: 'AAAA-BBBB' } });
  expect(reg.ok()).toBeTruthy();
  const cookie = reg.headers()['set-cookie'] || '';
  const get = await request.post(baseURL + '/api/settings/get', { headers: { cookie }, data: {} });
  expect(get.ok()).toBeTruthy();
  const create = await request.post(baseURL + '/api/characters/create', { headers: { cookie }, multipart: { name: 'E2E' } });
  expect(create.ok()).toBeTruthy();
});
