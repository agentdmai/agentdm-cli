// Railway deploy provider. Speaks Railway's public GraphQL API directly —
// no `railway` CLI dependency. Each mutation is in its own function so a
// schema change only touches one place.
//
// Caveats worth knowing before you debug a failure:
//   1. The token must be a personal Account Token (railway.com/account/tokens),
//      NOT a per-project token. Project tokens can only mutate their own
//      project and can't create new ones.
//   2. The "deploy from a GitHub repo" path needs the user's GitHub to be
//      connected to their Railway account already (one-time setup in the
//      Railway dashboard). Without it, serviceCreate with a `source.repo`
//      returns "repository not found" or similar.
//   3. Railway's GraphQL schema does evolve. If a mutation 4xx's, the error
//      surface here logs the full response body so the next maintainer can
//      see exactly which field changed.

import prompts from 'prompts';
import kleur from 'kleur';
import { getRailwayToken } from '../railway-token.js';
import { openUrl } from '../open-url.js';

const GRAPHQL_URL = 'https://backboard.railway.com/graphql/v2';

class RailwayClient {
  constructor(token) {
    this.token = token;
  }

  async request(query, variables) {
    const res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Railway returned non-JSON ${res.status}: ${text.slice(0, 400)}`);
    }
    if (body.errors?.length) {
      const msg = body.errors.map((e) => e.message).join('; ');
      throw new Error(`Railway GraphQL error: ${msg}`);
    }
    if (!res.ok) {
      throw new Error(`Railway HTTP ${res.status}: ${text.slice(0, 400)}`);
    }
    return body.data;
  }

  async whoami() {
    // Pull workspaces in the same hop so we can ask the user which one to
    // deploy into (Railway requires workspaceId on projectCreate).
    try {
      const data = await this.request(
        `query { me { id email name workspaces { id name } } }`,
      );
      return data?.me ?? null;
    } catch (err) {
      // Workspace- and project-scoped tokens have no user identity, so `me`
      // returns Not Authorized. Reword the error so the user knows what to
      // change instead of staring at a raw GraphQL message.
      if (/Not Authorized/i.test(err.message)) {
        throw new Error(
          'Railway token rejected the `me` query — this looks like a workspace-scoped or project token.\n' +
            'Create an account-level token instead:\n' +
            '  1. https://railway.com/account/tokens\n' +
            '  2. Click "Create New Token"\n' +
            '  3. Leave the workspace dropdown set to "No workspace", then save.\n',
        );
      }
      throw err;
    }
  }

  async projectCreate({ name, workspaceId }) {
    if (!workspaceId) throw new Error('workspaceId is required');
    const data = await this.request(
      `mutation ProjectCreate($input: ProjectCreateInput!) {
         projectCreate(input: $input) {
           id
           name
           environments { edges { node { id name } } }
         }
       }`,
      { input: { name, workspaceId } },
    );
    const project = data?.projectCreate;
    if (!project?.id) throw new Error('projectCreate did not return an id');
    const envEdge = project.environments?.edges?.[0];
    const environmentId = envEdge?.node?.id;
    if (!environmentId) throw new Error('project has no default environment');
    return { id: project.id, name: project.name, environmentId };
  }

  async serviceCreateFromRepo({ projectId, repo, branch = 'main', name }) {
    const data = await this.request(
      `mutation ServiceCreate($input: ServiceCreateInput!) {
         serviceCreate(input: $input) {
           id
           name
         }
       }`,
      {
        input: {
          projectId,
          name,
          source: { repo },
          branch,
        },
      },
    );
    const service = data?.serviceCreate;
    if (!service?.id) throw new Error('serviceCreate did not return an id');
    return service;
  }

  async variableUpsert({ projectId, environmentId, serviceId, name, value }) {
    await this.request(
      `mutation VariableUpsert($input: VariableUpsertInput!) {
         variableUpsert(input: $input)
       }`,
      {
        input: { projectId, environmentId, serviceId, name, value },
      },
    );
  }

  async setVariables({ projectId, environmentId, serviceId, vars, log }) {
    for (const [name, value] of Object.entries(vars)) {
      if (value === undefined || value === null || value === '') continue;
      log(`  setting ${name}`);
      await this.variableUpsert({
        projectId,
        environmentId,
        serviceId,
        name,
        value: String(value),
      });
    }
  }
}

async function pickWorkspace({ onCancel, workspaces }) {
  if (!workspaces || workspaces.length === 0) {
    throw new Error(
      'Your Railway account has no workspaces. Create one in the Railway dashboard first.',
    );
  }
  if (workspaces.length === 1) {
    return workspaces[0];
  }
  const { id } = await prompts(
    [
      {
        type: 'select',
        name: 'id',
        message: 'Which Railway workspace should the project go into?',
        choices: workspaces.map((w) => ({ title: w.name, value: w.id })),
        initial: 0,
      },
    ],
    { onCancel },
  );
  return workspaces.find((w) => w.id === id);
}

async function pickName({ onCancel, defaultName }) {
  const { name } = await prompts(
    [
      {
        type: 'text',
        name: 'name',
        message: 'Railway project name',
        initial: defaultName,
        validate: (v) => (v && v.trim().length > 0 ? true : 'name is required'),
      },
    ],
    { onCancel },
  );
  return name.trim();
}

async function pickRepoSource({ onCancel }) {
  const answers = await prompts(
    [
      {
        type: 'text',
        name: 'repo',
        message: 'GitHub source (owner/repo with the Dockerfile)',
        initial: 'agentdmai/agentdm-cli',
      },
      {
        type: 'text',
        name: 'branch',
        message: 'Branch to deploy',
        initial: 'main',
      },
    ],
    { onCancel },
  );
  return { repo: answers.repo.trim(), branch: answers.branch.trim() };
}

export const railwayProvider = {
  id: 'railway',
  label: 'Railway (railway.com)',
  description: 'Long-running container, env vars, free hobby tier.',

  /**
   * Deploy by:
   *   1. Auth (token via env / browser flow).
   *   2. Pick project name + source repo.
   *   3. projectCreate -> serviceCreate -> setVariables.
   *   4. Open the project's Railway dashboard URL.
   *
   * Returns { url, projectId, serviceId } so the CLI can print + remember.
   */
  async deploy({ envVars, onCancel, log = (m) => process.stdout.write(`${m}\n`) }) {
    const token = await getRailwayToken({ onCancel });
    const client = new RailwayClient(token);

    log(kleur.dim('verifying token…'));
    const me = await client.whoami();
    if (!me) throw new Error('Railway token is not associated with an account');
    log(kleur.green(`signed in as ${me.email}`));

    const workspace = await pickWorkspace({
      onCancel,
      workspaces: me.workspaces || [],
    });
    if ((me.workspaces || []).length > 1) {
      log(kleur.dim(`using workspace: ${workspace.name}`));
    }

    const projectName = await pickName({ onCancel, defaultName: 'askmyagent' });
    const { repo, branch } = await pickRepoSource({ onCancel });

    log(kleur.dim(`\ncreating project "${projectName}" in ${workspace.name}…`));
    const project = await client.projectCreate({
      name: projectName,
      workspaceId: workspace.id,
    });
    log(kleur.green(`project created: ${project.id}`));

    log(kleur.dim(`creating service from ${repo}@${branch}…`));
    const service = await client.serviceCreateFromRepo({
      projectId: project.id,
      repo,
      branch,
      name: 'agentdm-runtime',
    });
    log(kleur.green(`service created: ${service.id}`));

    log(kleur.dim('setting environment variables…'));
    await client.setVariables({
      projectId: project.id,
      environmentId: project.environmentId,
      serviceId: service.id,
      vars: envVars,
      log,
    });

    const url = `https://railway.com/project/${project.id}`;
    log('\n' + kleur.bold('Deployed.') + '\n' + kleur.cyan(`  ${url}\n`));
    log(
      kleur.dim(
        'Railway is building the image now (this can take a few minutes the first time).\n' +
          'Watch the build + logs in the dashboard above.\n',
      ),
    );
    openUrl(url);

    return { url, projectId: project.id, serviceId: service.id };
  },
};
