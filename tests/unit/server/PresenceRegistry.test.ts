import { describe, expect, it } from 'vitest';
import { PresenceRegistry } from '@/server/realtime/PresenceRegistry';

describe('PresenceRegistry', () => {
  it('joins on the first socket and leaves on the last (multi-tab)', () => {
    const p = new PresenceRegistry();
    expect(p.add('u1', 'Alice', 's1')?.event).toBe('join');
    expect(p.add('u1', 'Alice', 's2')?.event).toBe('update');
    expect(p.get('u1')?.connections).toBe(2);
    expect(p.remove('u1', 's1')?.event).toBe('update');
    expect(p.remove('u1', 's2')?.event).toBe('leave');
    expect(p.list()).toEqual([]);
  });

  it('tracks drawing per socket and editing per user, reporting only real changes', () => {
    const p = new PresenceRegistry();
    p.add('u1', 'Alice', 's1');
    p.add('u1', 'Alice', 's2');
    expect(p.setDrawing('u1', 's1', true)?.user.drawing).toBe(true);
    expect(p.setDrawing('u1', 's2', true)).toBeNull(); // still drawing
    expect(p.setDrawing('u1', 's1', false)).toBeNull(); // s2 still drawing
    expect(p.setDrawing('u1', 's2', false)?.user.drawing).toBe(false);
    expect(p.setEditing('u1', 'a1')?.user.editingAreaId).toBe('a1');
    expect(p.setEditing('u1', 'a1')).toBeNull();
  });

  it('assigns a stable colour per user', () => {
    const p = new PresenceRegistry();
    const a = p.add('u1', 'Alice', 's1')!.user.color;
    p.remove('u1', 's1');
    expect(p.add('u1', 'Alice', 's9')!.user.color).toBe(a);
  });
});
