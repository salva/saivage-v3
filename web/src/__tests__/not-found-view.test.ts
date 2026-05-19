import { describe, expect, it } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createRouter, createMemoryHistory } from 'vue-router';
import NotFound from '../views/NotFound.vue';

describe('NotFound route', () => {
  it('renders escaped requested path and links back to dashboard and cards', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/dashboard', component: { template: '<div>dashboard</div>' } },
        { path: '/cards', component: { template: '<div>cards</div>' } },
        { path: '/:pathMatch(.*)*', name: 'not-found', component: NotFound },
      ],
    });
    await router.push('/no-such-route?<script>alert(1)</script>');
    await router.isReady();
    const wrapper = mount(NotFound, { global: { plugins: [router] } });
    await flushPromises();

    expect(wrapper.text()).toContain('404 — Not found');
    expect(wrapper.text()).toContain('/no-such-route?');
    expect(wrapper.html()).not.toContain('<script>alert(1)</script>');
    expect(wrapper.findAll('a').map((a) => a.attributes('href'))).toEqual(['/dashboard', '/cards']);
  });
});
