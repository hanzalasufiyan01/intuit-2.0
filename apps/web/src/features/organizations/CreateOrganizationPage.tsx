import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { SESSION_QUERY_KEY, useApiMutation } from '../../auth/auth-context';
import { api } from '../../services/api-client';
import { ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { TextField } from '../../shared/ui/TextField';

export function CreateOrganizationPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const mutation = useApiMutation((input: { name: string }) =>
    api.post<{ id: string; name: string }>('/organizations', input),
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    mutation.mutate(
      { name },
      {
        onSuccess: async () => {
          // The new organization becomes active; reload session state and drop org-scoped caches.
          queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== SESSION_QUERY_KEY[0] });
          await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
          void navigate('/');
        },
      },
    );
  };

  return (
    <>
      <PageHeader
        title="New organization"
        description="You will be the Owner of the new organization."
      />
      <Card>
        <form className="form" onSubmit={submit} noValidate>
          <ErrorAlert error={mutation.error?.issues.length ? null : mutation.error} />
          <TextField
            label="Organization name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={mutation.error?.fieldError('name')}
          />
          <Button type="submit" busy={mutation.isPending}>
            Create organization
          </Button>
        </form>
      </Card>
    </>
  );
}
