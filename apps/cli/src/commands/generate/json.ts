import { readFile } from 'node:fs/promises';

import type { StructureOutputParams } from '@lobechat/types';
import type { Command } from 'commander';

import { getTrpcClient } from '../../api/client';
import { log } from '../../utils/logger';

type StructuredSchema = NonNullable<StructureOutputParams['schema']>;

/** Without `--schema` the command still promises JSON, so ask for any object. */
const ANY_OBJECT_SCHEMA: StructuredSchema['schema'] = {
  additionalProperties: true,
  properties: {},
  type: 'object',
};

export function registerJsonCommand(parent: Command) {
  parent
    .command('json <prompt>')
    .description('Generate a JSON object with an LLM (structured output, single completion)')
    .option('-m, --model <model>', 'Model ID (provider/model format)', 'openai/gpt-4o-mini')
    .option('-p, --provider <provider>', 'Provider name (derived from model if omitted)')
    .option('-s, --system <prompt>', 'System prompt')
    .option(
      '--schema <schema>',
      'JSON Schema for the reply — inline JSON or a path to a .json file (default: any object)',
    )
    .option('--schema-name <name>', 'Schema name sent to the model', 'response')
    .option('--strict', 'Require the model to adhere strictly to the schema')
    .option('--pipe', 'Pipe mode: read additional context from stdin')
    .action(
      async (
        prompt: string,
        options: {
          model: string;
          pipe?: boolean;
          provider?: string;
          schema?: string;
          schemaName?: string;
          strict?: boolean;
          system?: string;
        },
      ) => {
        // Resolve provider from model if not specified
        const parts = options.model.split('/');
        const provider = options.provider || (parts.length > 1 ? parts[0] : 'openai');
        const model = parts.length > 1 ? parts.slice(1).join('/') : options.model;

        const resolved = await resolveSchema(options);
        if ('error' in resolved) {
          log.error(resolved.error);
          process.exit(1);
          return;
        }

        // Read additional input from stdin if --pipe
        let fullPrompt = prompt;
        if (options.pipe) {
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) {
            chunks.push(chunk as Buffer);
          }
          const stdinContent = Buffer.concat(chunks).toString('utf8').trim();
          if (stdinContent) {
            fullPrompt = `${prompt}\n\n${stdinContent}`;
          }
        }

        const messages: Array<{ content: string; role: string }> = [];
        if (options.system) {
          messages.push({ content: options.system, role: 'system' });
        }
        messages.push({ content: fullPrompt, role: 'user' });

        // Structured output runs through the `aiChat.outputJSON` mutation rather
        // than `/webapi/chat`: the server owns the provider-specific handling
        // (`json_schema` support, the tool-calling fallback, Responses API
        // routing) and hands back the parsed object.
        const client = await getTrpcClient();

        let result: { data?: unknown };
        try {
          result = await client.aiChat.outputJSON.mutate({
            messages,
            model,
            provider,
            schema: resolved.value,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log.error(`JSON generation failed: ${message}`);
          process.exit(1);
          return;
        }

        // Schema mode resolves an unparsable reply (prose, truncated JSON) to
        // `undefined` instead of throwing, so a missing payload is a failure.
        if (result.data === undefined) {
          log.error('The model reply was not valid JSON for the given schema.');
          process.exit(1);
          return;
        }

        console.log(JSON.stringify(result.data, null, 2));
      },
    );
}

/**
 * Build the schema sent to the server: `--schema` supplies one, otherwise any
 * JSON object is requested.
 */
async function resolveSchema(options: {
  schema?: string;
  schemaName?: string;
  strict?: boolean;
}): Promise<{ error: string } | { value: StructuredSchema }> {
  const base = {
    name: options.schemaName || 'response',
    ...(options.strict ? { strict: true } : {}),
  };

  if (!options.schema) {
    return { value: { ...base, schema: ANY_OBJECT_SCHEMA } };
  }

  const parsed = await readSchema(options.schema);
  if ('error' in parsed) return parsed;

  return { value: { ...base, schema: parsed.value } };
}

/** `--schema` accepts inline JSON, a `.json` path, or an `@`-prefixed path. */
async function readSchema(
  raw: string,
): Promise<{ error: string } | { value: StructuredSchema['schema'] }> {
  const trimmed = raw.trim();
  let text = trimmed;

  if (!trimmed.startsWith('{')) {
    const filePath = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
    try {
      text = await readFile(filePath, 'utf8');
    } catch {
      return {
        error: `Cannot read schema file "${filePath}". Pass inline JSON or a readable path.`,
      };
    }
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: 'The value passed to --schema is not valid JSON.' };
  }

  if (!isObjectSchema(value)) {
    return { error: 'The schema must be an object schema with a `properties` object.' };
  }

  return { value };
}

function isObjectSchema(value: unknown): value is StructuredSchema['schema'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;

  const candidate = value as Record<string, unknown>;

  return (
    candidate.type === 'object' &&
    typeof candidate.properties === 'object' &&
    candidate.properties !== null &&
    !Array.isArray(candidate.properties)
  );
}
