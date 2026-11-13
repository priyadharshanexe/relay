import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { SESSION_QUERY_KEY, useAuth } from "../auth/AuthProvider";
import { SecretReveal } from "../components/SecretReveal";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  ErrorState,
  Field,
  Input,
  LoadingState,
  Modal,
  PageHeader,
  Select,
} from "../components/ui";
import { api, fieldErrors, setCurrentOrgId } from "../lib/api";
import { fullDate, timeAgo } from "../lib/format";
import type { Invitation, InvitationCreated, Member, Organization, Role } from "../lib/types";
import { emailAddress, requiredText } from "../lib/validate";

const MEMBERS = ["members"] as const;
const INVITATIONS = ["invitations"] as const;

export const ROLES: { value: Role; label: string; explain: string }[] = [
  { value: "owner", label: "Owner", explain: "Manages the team, and can do everything else." },
  {
    value: "developer",
    label: "Developer",
    explain: "Manages endpoints and API keys, and can retry deliveries.",
  },
  { value: "viewer", label: "Viewer", explain: "Can look at everything, and change nothing." },
];

export function invitationLink(token: string): string {
  return `${window.location.origin}/invite/${token}`;
}

// ----------------------------------------------------------------- organisation
function OrganizationCard() {
  const { organization, isOwner } = useAuth();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [clientError, setClientError] = useState<string>();

  const rename = useMutation({
    mutationFn: () =>
      api<Organization>("/v1/orgs/current", { method: "PATCH", body: { name: name.trim() } }),
    onSuccess: async () => {
      setEditing(false);
      // The name is part of the session (the organisation switcher shows it).
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    },
  });

  function open() {
    setName(organization.name);
    setClientError(undefined);
    rename.reset();
    setEditing(true);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const problem =
      requiredText(name, "a name for the organisation") ??
      (name.trim().length > 200 ? "Use at most 200 characters." : undefined);
    setClientError(problem);
    if (problem) {
      rename.reset();
      return;
    }
    rename.mutate();
  }

  const nameError = clientError ?? fieldErrors(rename.error).name;

  return (
    <Card className="mb-8 flex flex-wrap items-center justify-between gap-4 px-5 py-4">
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Organisation</p>
        <p className="mt-1 truncate text-base font-semibold text-slate-900">{organization.name}</p>
      </div>
      {isOwner && <Button onClick={open}>Rename</Button>}

      <Modal title="Rename organisation" open={editing} onClose={() => setEditing(false)}>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field label="Organisation name" error={nameError}>
            {(props) => (
              <Input {...props} value={name} onChange={(event) => setName(event.target.value)} />
            )}
          </Field>
          {rename.isError && !nameError && <ErrorState error={rename.error} />}
          <div className="flex justify-end gap-3">
            <Button onClick={() => setEditing(false)}>Cancel</Button>
            <Button type="submit" variant="primary" busy={rename.isPending}>
              Save name
            </Button>
          </div>
        </form>
      </Modal>
    </Card>
  );
}

// ---------------------------------------------------------------------- members
function MembersCard() {
  const { session, isOwner } = useAuth();
  const queryClient = useQueryClient();
  const [removing, setRemoving] = useState<Member | null>(null);

  const members = useQuery({
    queryKey: MEMBERS,
    queryFn: () => api<Member[]>("/v1/orgs/current/members"),
  });

  /** A change to my own membership changes what I may do: reload the session. */
  async function afterChange(userId: string, left: boolean) {
    if (userId === session.user.id) {
      if (left) {
        setCurrentOrgId(null);
        queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "session" });
      }
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    }
    if (!left || userId !== session.user.id) {
      await queryClient.invalidateQueries({ queryKey: MEMBERS });
    }
  }

  const changeRole = useMutation({
    mutationFn: ({ member, role }: { member: Member; role: Role }) =>
      api<Member>(`/v1/orgs/current/members/${member.user_id}`, {
        method: "PATCH",
        body: { role },
      }),
    onSuccess: (_, { member }) => afterChange(member.user_id, false),
  });

  const remove = useMutation({
    mutationFn: (member: Member) =>
      api<void>(`/v1/orgs/current/members/${member.user_id}`, { method: "DELETE" }),
    onSuccess: async (_, member) => {
      setRemoving(null);
      await afterChange(member.user_id, true);
    },
  });

  function closeRemove() {
    setRemoving(null);
    remove.reset();
  }

  const isMe = (member: Member) => member.user_id === session.user.id;

  return (
    <section aria-labelledby="members-heading" className="mb-8">
      <h2 id="members-heading" className="mb-3 text-sm font-semibold text-slate-900">
        Members
      </h2>
      {members.isPending && <LoadingState label="Loading members…" />}
      {members.isError && <ErrorState error={members.error} onRetry={() => void members.refetch()} />}
      {changeRole.isError && (
        <div className="mb-3">
          <ErrorState error={changeRole.error} />
        </div>
      )}
      {members.data && (
        <Card className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="px-5 py-3">Email</th>
                <th scope="col" className="px-5 py-3">Role</th>
                <th scope="col" className="px-5 py-3">Joined</th>
                <th scope="col" className="px-5 py-3">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-slate-700">
              {members.data.map((member) => (
                <tr key={member.user_id}>
                  <td className="px-5 py-3 font-medium">
                    {member.email}
                    {isMe(member) && (
                      <span className="ml-2">
                        <Badge>You</Badge>
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    {isOwner ? (
                      <Select
                        aria-label={`Role of ${member.email}`}
                        className="w-36"
                        value={member.role}
                        disabled={changeRole.isPending}
                        onChange={(event) =>
                          changeRole.mutate({ member, role: event.target.value as Role })
                        }
                      >
                        {ROLES.map((role) => (
                          <option key={role.value} value={role.value}>
                            {role.label}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <Badge tone={member.role === "viewer" ? "slate" : "blue"}>{member.role}</Badge>
                    )}
                  </td>
                  <td className="px-5 py-3" title={fullDate(member.joined_at)}>
                    {timeAgo(member.joined_at)}
                  </td>
                  <td className="px-5 py-3 text-right">
                    {isOwner && (
                      <Button size="sm" variant="ghost" onClick={() => setRemoving(member)}>
                        {isMe(member) ? "Leave" : "Remove"}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <dl className="mt-3 space-y-1 text-xs text-slate-500">
        {ROLES.map((role) => (
          <div key={role.value} className="flex gap-1">
            <dt className="font-medium text-slate-600">{role.label}:</dt>
            <dd>{role.explain}</dd>
          </div>
        ))}
      </dl>

      <ConfirmDialog
        open={removing !== null}
        title={removing && isMe(removing) ? "Leave this organisation?" : "Remove this member?"}
        confirmLabel={removing && isMe(removing) ? "Leave organisation" : "Remove member"}
        danger
        busy={remove.isPending}
        error={remove.isError ? remove.error : undefined}
        onConfirm={() => removing && remove.mutate(removing)}
        onClose={closeRemove}
      >
        {removing && isMe(removing) ? (
          <>You will lose access to everything in this organisation straight away.</>
        ) : (
          <>
            <strong>{removing?.email}</strong> will lose access to this organisation straight away.
            Their account is not deleted, and you can invite them again.
          </>
        )}
      </ConfirmDialog>
    </section>
  );
}

// ------------------------------------------------------------------ invitations
function InvitationsCard() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("developer");
  const [clientError, setClientError] = useState<string>();
  const [created, setCreated] = useState<InvitationCreated | null>(null);
  const [revoking, setRevoking] = useState<Invitation | null>(null);

  const invitations = useQuery({
    queryKey: INVITATIONS,
    queryFn: () => api<Invitation[]>("/v1/orgs/current/invitations"),
  });

  const create = useMutation({
    mutationFn: () =>
      api<InvitationCreated>("/v1/orgs/current/invitations", {
        method: "POST",
        body: { email: email.trim(), role },
      }),
    onSuccess: async (invitation) => {
      setCreating(false);
      setEmail("");
      setRole("developer");
      setCreated(invitation);
      await queryClient.invalidateQueries({ queryKey: INVITATIONS });
    },
  });

  const revoke = useMutation({
    mutationFn: (invitation: Invitation) =>
      api<void>(`/v1/orgs/current/invitations/${invitation.id}`, { method: "DELETE" }),
    onSuccess: async () => {
      setRevoking(null);
      await queryClient.invalidateQueries({ queryKey: INVITATIONS });
    },
  });

  function open() {
    setClientError(undefined);
    create.reset();
    setCreating(true);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const problem = email.trim()
      ? emailAddress(email)
      : "Enter the email address of the person to invite.";
    setClientError(problem);
    if (problem) {
      create.reset();
      return;
    }
    create.mutate();
  }

  const emailError = clientError ?? fieldErrors(create.error).email;
  const selectedRole = ROLES.find((item) => item.value === role);

  return (
    <section aria-labelledby="invitations-heading">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 id="invitations-heading" className="text-sm font-semibold text-slate-900">
          Pending invitations
        </h2>
        <Button variant="primary" onClick={open}>
          Invite someone
        </Button>
      </div>

      {invitations.isPending && <LoadingState label="Loading invitations…" />}
      {invitations.isError && (
        <ErrorState error={invitations.error} onRetry={() => void invitations.refetch()} />
      )}
      {invitations.data?.length === 0 && (
        <Card className="px-5 py-6 text-sm text-slate-500">
          Nobody is waiting to join. Invite someone to get a link you can send them.
        </Card>
      )}
      {invitations.data && invitations.data.length > 0 && (
        <Card className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="px-5 py-3">Email</th>
                <th scope="col" className="px-5 py-3">Role</th>
                <th scope="col" className="px-5 py-3">Expires</th>
                <th scope="col" className="px-5 py-3">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-slate-700">
              {invitations.data.map((invitation) => (
                <tr key={invitation.id}>
                  <td className="px-5 py-3 font-medium">{invitation.email}</td>
                  <td className="px-5 py-3">
                    <Badge tone={invitation.role === "viewer" ? "slate" : "blue"}>
                      {invitation.role}
                    </Badge>
                  </td>
                  <td className="px-5 py-3" title={fullDate(invitation.expires_at)}>
                    {timeAgo(invitation.expires_at)}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <Button size="sm" variant="ghost" onClick={() => setRevoking(invitation)}>
                      Revoke
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Modal title="Invite someone" open={creating} onClose={() => setCreating(false)}>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field
            label="Email"
            hint="Only this address will be able to use the invitation."
            error={emailError}
          >
            {(props) => (
              <Input
                {...props}
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="teammate@example.com"
              />
            )}
          </Field>
          <Field label="Role" hint={selectedRole?.explain}>
            {(props) => (
              <Select
                {...props}
                value={role}
                onChange={(event) => setRole(event.target.value as Role)}
              >
                {ROLES.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {create.isError && !emailError && <ErrorState error={create.error} />}
          <div className="flex justify-end gap-3">
            <Button onClick={() => setCreating(false)}>Cancel</Button>
            <Button type="submit" variant="primary" busy={create.isPending}>
              Create invitation
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        title="Send this invitation link"
        open={created !== null}
        onClose={() => setCreated(null)}
        dismissible={false}
      >
        {created && (
          <>
            <SecretReveal
              label={`Invitation link for ${created.email}`}
              secret={invitationLink(created.token)}
            />
            <p className="mt-4 text-sm text-slate-600">
              Relay does not send email. Send this link to {created.email} yourself. It works once,
              only for that address, until {fullDate(created.expires_at)}.
            </p>
            <div className="mt-5 flex justify-end">
              <Button variant="primary" onClick={() => setCreated(null)}>
                I have copied it
              </Button>
            </div>
          </>
        )}
      </Modal>

      <ConfirmDialog
        open={revoking !== null}
        title="Revoke this invitation?"
        confirmLabel="Revoke invitation"
        danger
        busy={revoke.isPending}
        error={revoke.isError ? revoke.error : undefined}
        onConfirm={() => revoking && revoke.mutate(revoking)}
        onClose={() => setRevoking(null)}
      >
        The link sent to <strong>{revoking?.email}</strong> will stop working. You can invite them
        again later.
      </ConfirmDialog>
    </section>
  );
}

export function TeamPage() {
  const { isOwner } = useAuth();
  return (
    <>
      <PageHeader
        title="Team"
        description={
          isOwner
            ? "Who can use this organisation, and what each person may do."
            : "Who can use this organisation. Only an owner can change the team."
        }
      />
      <OrganizationCard />
      <MembersCard />
      {isOwner && <InvitationsCard />}
    </>
  );
}
