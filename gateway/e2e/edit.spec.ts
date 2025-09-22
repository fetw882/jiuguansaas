import { test, expect } from '@playwright/test';

test('Character edit via JSON body updates first message', async ({ request, baseURL }) => {
  const reg = await request.post(baseURL + '/api/auth/register', { data: { email: 'edit-e2e@test', password: 'x', card: 'AAAA-BBBB' } });
  expect(reg.ok()).toBeTruthy();
  const cookie = reg.headers()['set-cookie'] || '';

  const cr = await request.post(baseURL + '/api/characters/create', { headers: { cookie }, multipart: { name: 'EditE2E' } });
  expect(cr.ok()).toBeTruthy();

  const list = await request.post(baseURL + '/api/characters/all', { headers: { cookie }, data: {} });
  const chars = await list.json();
  const av = chars[0].avatar;

  const ed = await request.post(baseURL + '/api/characters/edit', { headers: { cookie }, data: { avatar_url: av, first_message: 'Updated' } });
  expect(ed.ok()).toBeTruthy();

  const one = await request.post(baseURL + '/api/characters/get', { headers: { cookie }, data: { avatar_url: av } });
  const ch = await one.json();
  expect(ch.first_mes).toBe('Updated');
});

