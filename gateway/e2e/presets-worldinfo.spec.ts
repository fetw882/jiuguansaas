import { test, expect } from '@playwright/test';

test('presets save and restore', async ({ request, baseURL }) => {
  const reg = await request.post(baseURL + '/api/auth/register', { data: { email: 'pw@test', password: 'x', card: 'AAAA-BBBB' } });
  const cookie = reg.headers()['set-cookie'] || '';
  const save = await request.post(baseURL + '/api/presets/save', { headers: { cookie }, data: { name: 'P', preset: { a: 1 } } });
  expect(save.ok()).toBeTruthy();
  const get = await request.post(baseURL + '/api/presets/restore', { headers: { cookie }, data: { name: 'P' } });
  expect((await get.json()).a).toBe(1);
});

test('worldinfo basic flow', async ({ request, baseURL }) => {
  const reg = await request.post(baseURL + '/api/auth/register', { data: { email: 'wi@test', password: 'x', card: 'AAAA-BBBB' } });
  const cookie = reg.headers()['set-cookie'] || '';
  const imp = await request.post(baseURL + '/api/worldinfo/import', { headers: { cookie }, multipart: { name: 'W' } });
  expect(imp.ok()).toBeTruthy();
  const list = await request.post(baseURL + '/api/worldinfo/get', { headers: { cookie }, data: {} });
  const arr = await list.json();
  expect(Array.isArray(arr)).toBeTruthy();
});
