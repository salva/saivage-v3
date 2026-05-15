import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import NavRail from '../components/nav/NavRail.vue';
import type { NavItem } from '../components/nav/types';

const routeState: { name?: string; path?: string } = {};

vi.mock('vue-router', () => ({
  useRoute: () => routeState,
}));

const navItems: NavItem[] = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    shortcut: '1',
    icon: '<svg></svg>',
    to: '/dashboard',
    activePatterns: ['dashboard', '/dashboard'],
  },
];

function mountNav(props?: Record<string, unknown>) {
  return mount(NavRail, {
    props: { navItems, ...props },
    global: {
      stubs: {
        RouterLink: {
          props: ['to'],
          template: '<a><slot /></a>',
        },
      },
    },
  });
}

describe('NavRail', () => {
  it('does not throw when the current route has no name yet', () => {
    routeState.name = undefined;
    routeState.path = '/dashboard';
    expect(() => mountNav()).not.toThrow();
  });

  it('does not throw when route name and path are missing during startup', () => {
    routeState.name = undefined;
    routeState.path = undefined;
    expect(() => mountNav()).not.toThrow();
  });

  it('renders a Docs link when docsHref is provided', () => {
    routeState.name = 'dashboard';
    routeState.path = '/dashboard';

    const wrapper = mountNav({ docsHref: '/docs/' });
    const docsLink = wrapper.find('a[href="/docs/"]');

    expect(docsLink.exists()).toBe(true);
    expect(docsLink.text()).toContain('Docs');
    expect(docsLink.attributes('target')).toBe('_blank');
    expect(docsLink.attributes('aria-label')).toContain('public docs do not require API token');
  });

  it('keeps token button visible alongside Docs link', () => {
    const wrapper = mountNav({ docsHref: '/docs/' });
    expect(wrapper.find('.api-token-btn').exists()).toBe(true);
    expect(wrapper.text()).toContain('Token');
    expect(wrapper.text()).toContain('Docs');
  });
});
