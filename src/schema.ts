import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

// Input and projection budgets are characters, except collection counts.
export const LIMITS = {
	operations: 50,
	dependencies: 100,
	selectedIds: 5,
	summaryItems: 20,
	summaryChars: 8_000,
	jsonDepth: 32,
	subjectChars: 240,
	descriptionChars: 8_000,
	progressChars: 2_000,
	labelChars: 160,
	taskJsonChars: 16_000,
	outputChars: 24_000,
	contextChars: 6_000,
	contextFieldChars: 800,
} as const;
export const TASK_STATUSES = ["pending", "in_progress", "completed"] as const;
export const DEFAULT_TASK_STATUS = TASK_STATUSES[0];
export const StatusSchema = Type.Enum(TASK_STATUSES);
export const IdSchema = Type.String({ pattern: "^[1-9][0-9]*$", maxLength: String(Number.MAX_SAFE_INTEGER).length });
const text = (maxLength: number) => ({ ...Type.String({ minLength: 1, pattern: "\\S" }), maxLength });
const MetadataSchema = Type.Record(Type.String(), Type.Unknown());
const DependenciesSchema = Type.Array(IdSchema, { maxItems: LIMITS.dependencies, uniqueItems: true });
const requiredFields = { subject: text(LIMITS.subjectChars), description: text(LIMITS.descriptionChars) };
const optionalFields = {
	progress: text(LIMITS.progressChars),
	owner: text(LIMITS.labelChars),
	activeForm: text(LIMITS.labelChars),
	metadata: MetadataSchema,
};
export const TaskSchema = Type.Object(
	{
		id: IdSchema,
		...requiredFields,
		status: StatusSchema,
		dependsOn: DependenciesSchema,
		progress: Type.Optional(optionalFields.progress),
		owner: Type.Optional(optionalFields.owner),
		activeForm: Type.Optional(optionalFields.activeForm),
		metadata: Type.Optional(optionalFields.metadata),
	},
	{ additionalProperties: false },
);
const CreateSchema = Type.Object(
	{
		...requiredFields,
		status: Type.Optional({ ...StatusSchema, default: DEFAULT_TASK_STATUS }),
		dependsOn: Type.Optional(DependenciesSchema),
		progress: Type.Optional(Type.Union([optionalFields.progress, Type.Null()])),
		owner: Type.Optional(Type.Union([optionalFields.owner, Type.Null()])),
		activeForm: Type.Optional(Type.Union([optionalFields.activeForm, Type.Null()])),
		metadata: Type.Optional(Type.Union([optionalFields.metadata, Type.Null()])),
	},
	{ additionalProperties: false },
);
const UpdateSchema = Type.Partial(CreateSchema, { additionalProperties: false });
export const WriteSchema = Type.Object(
	{
		operations: Type.Array(
			Type.Union([
				Type.Object({ action: Type.Literal("create"), task: CreateSchema }, { additionalProperties: false }),
				Type.Object(
					{ action: Type.Literal("update"), id: IdSchema, set: UpdateSchema },
					{ additionalProperties: false },
				),
				Type.Object({ action: Type.Literal("delete"), id: IdSchema }, { additionalProperties: false }),
			]),
			{ minItems: 1, maxItems: LIMITS.operations },
		),
	},
	{ additionalProperties: false },
);
export const ReadSchema = Type.Object(
	{
		view: Type.Optional(Type.Enum(["summary", "details"])),
		scope: Type.Optional(Type.Enum(["active", "all"])),
		afterId: Type.Optional(IdSchema),
		ids: Type.Optional(Type.Array(IdSchema, { minItems: 1, maxItems: LIMITS.selectedIds, uniqueItems: true })),
	},
	{ additionalProperties: false },
);
export type Task = Readonly<Static<typeof TaskSchema>>;
export type TaskStatus = Task["status"];
export type WriteInput = Static<typeof WriteSchema>;
export type TaskOperation = WriteInput["operations"][number];
export type ReadInput = Static<typeof ReadSchema>;
export type TaskPatch = Extract<TaskOperation, { action: "update" }>["set"];

export class TaskError extends Error {
	constructor(
		readonly code: "invalid_input" | "not_found" | "invalid_graph" | "unavailable" | "storage_error",
		readonly field: string,
		rule: string,
		readonly operationIndex?: number,
		readonly id?: string,
		options?: ErrorOptions,
	) {
		super(`${field}: ${rule}. Task state unchanged.`, options);
	}
}

export function validate<S extends TSchema>(schema: S, value: unknown, field: string): Static<S> {
	assertJson(value, field);
	if (!Value.Check(schema, value)) {
		const error = Value.Errors(schema, value)[0];
		const suffix = error?.keyword === "additionalProperties" ? `/${error.params.additionalProperties.join(",")}` : "";
		throw new TaskError(
			"invalid_input",
			`${field}${error?.instancePath ?? ""}${suffix}`,
			error?.message ?? "must match the declared schema",
		);
	}
	return value;
}

export function parseRead(value: unknown): ReadInput {
	const input = validate(ReadSchema, value, "query");
	if (input.view === "details") {
		if (!input.ids || input.scope !== undefined || input.afterId !== undefined)
			throw new TaskError("invalid_input", "query", "details requires ids and forbids scope and afterId");
	} else if (input.ids !== undefined) {
		throw new TaskError("invalid_input", "ids", "is only allowed with view details");
	}
	return input;
}

/** Bound JSON depth and reject values that would change or disappear on serialization. */
function assertJson(value: unknown, field: string, ancestors = new Set<object>()): void {
	if (value === null || typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number" && Number.isFinite(value)) return;
	if (typeof value !== "object" || ancestors.has(value) || ancestors.size >= LIMITS.jsonDepth)
		throw new TaskError(
			"invalid_input",
			field,
			`must contain finite, acyclic JSON values within ${LIMITS.jsonDepth} nesting levels`,
		);
	if (
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) !== Object.prototype &&
		Object.getPrototypeOf(value) !== null
	)
		throw new TaskError("invalid_input", field, "must contain only JSON objects and arrays");
	ancestors.add(value);
	for (const child of Object.values(value)) assertJson(child, field, ancestors);
	ancestors.delete(value);
}

export function validateTaskFields(patch: TaskPatch, field: string): void {
	// TypeBox counts graphemes; JSON Schema consumers count code points. Enforce the portable bound here.
	for (const key of ["subject", "description", "progress", "owner", "activeForm"] as const) {
		const value = patch[key];
		const limit = TaskSchema.properties[key].maxLength;
		if (typeof value === "string" && Array.from(value).length > limit)
			throw new TaskError("invalid_input", `${field}/${key}`, `must contain at most ${limit} Unicode code points`);
	}
}

export function parseWrite(value: unknown): WriteInput {
	const input = validate(WriteSchema, value, "write");
	for (const [index, op] of input.operations.entries()) {
		const patch = op.action === "create" ? op.task : op.action === "update" ? op.set : undefined;
		if (patch) validateTaskFields(patch, `operations/${index}`);
	}
	return input;
}

export const SummarySchema = Type.Object(
	{
		id: IdSchema,
		subject: TaskSchema.properties.subject,
		status: StatusSchema,
		owner: TaskSchema.properties.owner,
		blockedBy: Type.Array(IdSchema),
	},
	{ additionalProperties: false },
);
export const SummaryPageSchema = Type.Object(
	{
		ok: Type.Literal(true),
		view: Type.Literal("summary"),
		scope: Type.Union([Type.Literal("active"), Type.Literal("all")]),
		tasks: Type.Array(SummarySchema),
		total: Type.Integer(),
		omitted: Type.Integer(),
		nextAfterId: Type.Optional(IdSchema),
	},
	{ additionalProperties: false },
);
export const DetailPageSchema = Type.Object(
	{
		ok: Type.Literal(true),
		view: Type.Literal("details"),
		tasks: Type.Array(
			Type.Object({ ...TaskSchema.properties, blockedBy: Type.Array(IdSchema) }, { additionalProperties: false }),
		),
		nextIds: Type.Array(IdSchema),
	},
	{ additionalProperties: false },
);
export const WriteResultSchema = Type.Object(
	{
		ok: Type.Literal(true),
		changed: Type.Boolean(),
		outcomes: Type.Array(
			Type.Object(
				{
					action: Type.Union([Type.Literal("create"), Type.Literal("update"), Type.Literal("delete")]),
					id: IdSchema,
					changed: Type.Boolean(),
				},
				{ additionalProperties: false },
			),
		),
		active: SummaryPageSchema,
		nextReady: Type.Optional(SummarySchema),
	},
	{ additionalProperties: false },
);
export const FailureSchema = Type.Object(
	{
		ok: Type.Literal(false),
		error: Type.Object(
			{
				code: Type.String(),
				field: Type.String(),
				message: Type.String(),
				operationIndex: Type.Optional(Type.Integer()),
				id: Type.Optional(IdSchema),
			},
			{ additionalProperties: false },
		),
		active: Type.Optional(SummaryPageSchema),
	},
	{ additionalProperties: false },
);
export type Failure = Static<typeof FailureSchema>;
