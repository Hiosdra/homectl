import Ajv, { type ValidateFunction } from "ajv";
import schema from "../../schema/control-plane.schema.json";

// Ajv is compiled once. Errors are never echoed to clients: they can contain
// offending values, so callers map failures to a fixed message.
const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addSchema(schema, "control-plane");

export function definition(name: string): ValidateFunction {
  const validate = ajv.getSchema(`control-plane#/definitions/${name}`);
  if (!validate) throw new Error(`Missing control-plane definition: ${name}`);
  return validate;
}

export const schemas = {
  request: definition("request"),
  clientIdentity: definition("clientIdentity"),
  clientView: definition("clientView"),
  operationRecord: definition("operationRecord"),
  operationView: definition("operationView"),
  approvalView: definition("approvalView"),
  auditEntry: definition("auditEntry"),
};

export { schema as controlPlaneSchema };
