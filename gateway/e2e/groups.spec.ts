import { test, expect } from '@playwright/test';

test('Groups create, save chat, get and delete', async ({ request, baseURL }) => {
  const reg = await request.post(baseURL + '/api/auth/register', { data: { email: 'grp-e2e@test', password: 'x', card: 'AAAA-BBBB' } });
  expect(reg.ok()).toBeTruthy();
  const cookie = reg.headers()['set-cookie'] || '';

  const cr = await request.post(baseURL + '/api/groups/create', { headers: { cookie }, data: { name: 'G', members: [] } });
  expect(cr.ok()).toBeTruthy();
  const gid = (await cr.json()).id as string;

  const sv = await request.post(baseURL + '/api/chats/group/save', { headers: { cookie }, data: { id: gid, chat: [{ is_user: true, mes: 'Hi', create_date: '2025-09-16T20:00:00Z' }] } });
  expect(sv.ok()).toBeTruthy();

  const gt = await request.post(baseURL + '/api/chats/group/get', { headers: { cookie }, data: { id: gid } });
  expect(gt.ok()).toBeTruthy();
  const arr = await gt.json();
  expect(Array.isArray(arr)).toBeTruthy();
  expect(arr[0].mes).toBe('Hi');

  const del = await request.post(baseURL + '/api/chats/group/delete', { headers: { cookie }, data: { id: gid } });
  expect(del.ok()).toBeTruthy();
});

