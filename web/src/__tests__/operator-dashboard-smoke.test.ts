import { describe, expect, it } from 'vitest';
import dashboardSource from '../views/DashboardView.vue?raw';
import appShellSource from '../components/layout/AppShell.vue?raw';

describe('operator dashboard S06 smoke contract', () => {
  it('keeps passive runtime refresh and removes the dashboard-local analyst chat', () => {
    expect(dashboardSource).not.toContain('Analyst Chat');
    expect(dashboardSource).not.toContain('class="chat-input"');
    expect(dashboardSource).not.toContain('@click="sendChat"');
    expect(dashboardSource).toContain('Runtime Console');
    expect(dashboardSource).toContain('@click="refreshRuntime"');

    expect(dashboardSource).not.toMatch(/Start Project|Stop Project|startProject|stopProject/);
    expect(dashboardSource).not.toMatch(/NotificationsPanel|acknowledgeNotification/);
  });

  it('keeps the persistent analyst panel mounted by the shell with no drawer toggle', () => {
    expect(appShellSource).toContain('AnalystChatPanel');
    expect(appShellSource).toContain('workspace-content');
    expect(appShellSource).not.toMatch(/drawer|toggleAnalyst|open analyst|close analyst/i);
  });
});
