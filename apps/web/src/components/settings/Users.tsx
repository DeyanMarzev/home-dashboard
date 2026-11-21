import { formatAgo, type UserItem } from '@home/shared';
import { useMe } from '../../api/hooks.js';
import { usePatchUser, useUsers } from '../../api/settings.js';
import { useNow } from '../../lib/now-context.js';
import { Empty, Panel, Skeleton } from '../Cards.js';
import { Switch } from '../Switch.js';

/** Settings → Users (admins; docs/09 §7). Access itself is managed in Cloudflare Access. */
export function UsersPanel() {
  const users = useUsers(true);
  const me = useMe();
  return (
    <Panel id="users-h" title="Users (admin)" flex="1 1 100%">
      {users.isPending ? (
        <Skeleton height={120} />
      ) : users.isError ? (
        <Empty>{users.error.message}</Empty>
      ) : (
        <div className="stack">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  <th scope="col">Role</th>
                  <th scope="col">Access</th>
                  <th scope="col">Last seen</th>
                  <th scope="col">Devices</th>
                </tr>
              </thead>
              <tbody>
                {users.data.items.map((u) => (
                  <UserRow key={u.id} user={u} self={u.id === me.data?.id} />
                ))}
              </tbody>
            </table>
          </div>
          <p className="note">
            People appear here after their first visit. To let someone in, or take access away
            completely, change the policy in Cloudflare Access (Zero Trust → Access → Applications →
            Home dashboard). Admins from ADMIN_EMAILS on the Pi can&apos;t be changed here.
          </p>
        </div>
      )}
    </Panel>
  );
}

function UserRow({ user, self }: { user: UserItem; self: boolean }) {
  const now = useNow();
  const patch = usePatchUser();
  const locked = user.roleLocked || self;
  return (
    <tr>
      <td>
        {user.name ?? user.email}
        {user.name && <div className="small muted">{user.email}</div>}
        {self && <div className="small muted">you</div>}
        {patch.isError && <div className="small warn-text">{patch.error.message}</div>}
      </td>
      <td>
        <select
          aria-label={`Role of ${user.email}`}
          value={user.role}
          disabled={locked || patch.isPending}
          onChange={(e) =>
            patch.mutate({ id: user.id, patch: { role: e.target.value as UserItem['role'] } })
          }
        >
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
      </td>
      <td>
        <Switch
          checked={user.enabled}
          disabled={locked || patch.isPending}
          onChange={(on) => patch.mutate({ id: user.id, patch: { enabled: on } })}
        >
          {user.enabled ? 'Allowed' : 'Turned off'}
        </Switch>
      </td>
      <td>{user.lastSeenAt ? formatAgo(user.lastSeenAt, now) : 'never'}</td>
      <td>{user.devices}</td>
    </tr>
  );
}
