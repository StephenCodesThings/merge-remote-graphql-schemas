import {
  FieldNode,
  getNamedType,
  GraphQLArgument,
  GraphQLField,
  GraphQLFieldConfigArgumentMap,
  GraphQLFieldConfigMap,
  GraphQLFieldMap,
  GraphQLFieldResolver,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLNamedType,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLOutputType,
  GraphQLSchema,
  GraphQLUnionType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isSpecifiedScalarType,
  isUnionType,
} from "graphql";
import { delegateToSchema } from "graphql-tools";
import { camelCase, isArray, merge, mergeWith } from "lodash";

interface NewTypesMap { [key: string]: GraphQLNamedType; }

function mergeObjectTypes({ types, newTypes }: {
  types: ObjectTypeAndSchemaArray,
  newTypes: NewTypesMap,
}) {

  const mergeQuery = camelCase(types[0].type.name);

  return new GraphQLObjectType({
    name: types.map((type) => type.type.name).filter((name) => name)[0],
    description: types.map((type) => type.type.description).filter((d) => d)[0],
    isTypeOf: types.map((type) => type.type.isTypeOf).filter((a) => a)[0],
    astNode: types.map((type) => type.type.astNode).filter((a) => a)[0],
    extensionASTNodes: types.map((type) => type.type.extensionASTNodes).filter((a) => a)[0],
    fields: () => createFieldMapConfig({ types, newTypes, mergeQuery }),
    interfaces: () => mergeInterfaces({ types: types.map((type) => type.type), newTypes }),
  });
}

function mergeInterfaces({ types, newTypes }: {
  types: GraphQLObjectType[],
  newTypes: NewTypesMap,
}) {
  const interfaceMap: { [key: string]: GraphQLInterfaceType } = {};
  for (const type of types) {
    for (const i of type.getInterfaces()) {
      if (!interfaceMap[i.name]) {
        interfaceMap[i.name] = newTypes[i.name] ? newTypes[i.name] as GraphQLInterfaceType : i;
      }
    }
  }
  return Object.values(interfaceMap);
}

type NamedTypeAndSchemaArray = Array<{ schema: GraphQLSchema, type: GraphQLNamedType, replaceResolvers: boolean }>;
type ObjectTypeAndSchemaArray = Array<{ schema: GraphQLSchema, type: GraphQLObjectType, replaceResolvers: boolean }>;

function mergeRootTypes({ types, newTypes }: {
  types: ObjectTypeAndSchemaArray,
  newTypes: NewTypesMap,
}) {

  if (types.length === 0) {
    return undefined;
  } else {
    return new GraphQLObjectType({
      name: types.map((type) => type.type.name).filter((name) => name)[0],
      description: types.map((type) => type.type.description).filter((d) => d)[0],
      astNode: types.map((type) => type.type.astNode).filter((a) => a)[0],
      fields: () => createRootFieldMapConfig({ types, newTypes }),
    });
  }
}

function createRootFieldMapConfig({
  types,
  newTypes,
}: {
  types: ObjectTypeAndSchemaArray,
  newTypes: NewTypesMap,
}) {
  const fields: { [key: string]: Array<{ schema: GraphQLSchema, field: GraphQLField<any, any> }> } = {};
  for (const { type, schema } of types) {
    for (const [key, field] of Object.entries(type.getFields())) {
      if (!fields[key]) {
        fields[key] = [];
      }
      fields[key].push({ schema, field });
    }
  }
  const fieldsConfig: GraphQLFieldConfigMap<any, any> = {};
  for (const [key, fieldAndSchema] of Object.entries(fields)) {
    const fieldCandidates = fieldAndSchema.map((f) => f.field);
    const schemas = fieldAndSchema.map((f) => f.schema);
    const fieldType: GraphQLOutputType = getCandidateAttribute(fieldCandidates, "type");
    fieldsConfig[key] = {
      type: newTypes[getNamedType(fieldType).name] ? createFieldType(fieldType, newTypes) : fieldType,
      args: createArgumentConfig(getCandidateAttribute(Object.values(fieldCandidates), "args")),
      resolve: createRootResolver({ schemas }),
      deprecationReason: getCandidateAttribute(Object.values(fieldCandidates), "deprecationReason"),
      description: getCandidateAttribute(Object.values(fieldCandidates), "description"),
      astNode: getCandidateAttribute(Object.values(fieldCandidates), "astNode"),
    };
  }
  return fieldsConfig;
}

function getCandidateAttribute(candidates: any[], attribute: string) {
  const attributes = candidates.map((candidate) => candidate[attribute]).filter((value) => value);
  return attributes[0];
}

function createFieldMapConfig({
  types,
  newTypes,
  mergeQuery,
}: {
  types: ObjectTypeAndSchemaArray,
  newTypes: NewTypesMap,
  mergeQuery: string,
}): GraphQLFieldConfigMap<any, any> {
  const fields: {
    [key: string]: { schema: GraphQLSchema, field: GraphQLField<any, any>, replaceResolvers: boolean },
  } = {};
  for (const { type, schema, replaceResolvers } of types) {
    for (const [key, field] of Object.entries(type.getFields())) {
      if (!fields[key]) {
        fields[key] = { schema, field, replaceResolvers };
      }
    }
  }
  const fieldsConfig: GraphQLFieldConfigMap<any, any> = {};
  for (const [key, { field, schema, replaceResolvers }] of Object.entries(fields)) {
    fieldsConfig[key] = {
      type: newTypes[getNamedType(field.type).name] ? createFieldType(field.type, newTypes) : field.type,
      args: createArgumentConfig(field.args),
      resolve: replaceResolvers ?
        createFieldResolver(schema, mergeQuery) :
        createLocalFieldResolver({ resolve: field.resolve, field }),
      deprecationReason: field.deprecationReason,
      description: field.description,
      astNode: field.astNode,
    };
  }
  return fieldsConfig;
}

function createLocalFieldResolver({
  field,
  resolve,
}: {
  field: GraphQLField<any, any>,
  resolve?: GraphQLFieldResolver<any, any>,
}): GraphQLFieldResolver<any, any> | undefined {
  if (!resolve) {
    return undefined;
  }
  return async (parent, args, context, info) => {
    const result = await resolve(parent, args, context, info);
    return merge(
      parent,
      { [field.name]: result },
    )[field.name];
  };
}

function mergeWithConcat(objValue: any, srcValue: any) {
  if (isArray(objValue)) {
    return objValue.concat(srcValue);
  }
}

function createRootResolver({
  schemas,
}: {
  schemas: GraphQLSchema[],
}): GraphQLFieldResolver<any, any> {
  return (parent, args, context, info) => {
    return Promise.all(schemas.map((schema) => delegateToSchema({
      schema,
      operation: info.operation.operation,
      fieldName: info.fieldName,
      args,
      context,
      info,
    }))).then((results) => results.reduce(
      (left, right) => mergeWith(right, left, mergeWithConcat), isArray(results) ? [] : {},
    ));
  };
}

function createFieldResolver(schema: GraphQLSchema, mergeQuery?: string): GraphQLFieldResolver<any, any> {

  return (parent, args, context, info) => {
    const responseKey = info.fieldNodes[0].alias
      ? info.fieldNodes[0].alias.value
      : info.fieldName;

    const result = parent && parent[responseKey];
    if (result !== undefined) {
      return result;
    } else {
      if (mergeQuery) {
        info = {
          ...info,
          fieldNodes: [{
            kind: "Field",
            name: {
              kind: "Name",
              value: mergeQuery,
            },
            selectionSet: {
              kind: "SelectionSet",
              selections: info.fieldNodes,
            },
          } as FieldNode],
        };
      }
      const request = delegateToSchema({
        schema,
        operation: "query",
        fieldName: mergeQuery || info.fieldName,
        args: mergeQuery ? { id: parent.id } : args,
        context,
        info,
      });
      if (mergeQuery) {
        return request.then((requestResult) => requestResult[responseKey]);
      } else {
        return request;
      }
    }
  };
}

function createFieldType(type: GraphQLOutputType, newTypes: NewTypesMap): GraphQLOutputType {
  if (isNonNullType(type)) {
    return new GraphQLNonNull(createFieldType(type.ofType, newTypes));
  } else if (isListType(type)) {
    return new GraphQLList(createFieldType(type.ofType, newTypes));
  } else {
    return newTypes[type.name] as GraphQLOutputType;
  }
}

function recreateUnionType(type: GraphQLUnionType, newTypes: NewTypesMap) {
  return new GraphQLUnionType({
    name: type.name,
    description: type.description,
    astNode: type.astNode,
    extensionASTNodes: type.extensionASTNodes,
    types: () => type.getTypes().map((t) => (newTypes[t.name] || t) as GraphQLObjectType),
  });
}

function recreateInterfaceType(type: GraphQLInterfaceType, newTypes: NewTypesMap) {
  return new GraphQLInterfaceType({
    name: type.name,
    description: type.description,
    astNode: type.astNode,
    extensionASTNodes: type.extensionASTNodes,
    fields: () => recreateInterfaceFieldMap(type.getFields(), newTypes),
  });
}

function recreateInterfaceFieldMap(fields: GraphQLFieldMap<any, any>, newTypes: NewTypesMap) {
  const fieldsConfig: GraphQLFieldConfigMap<any, any> = {};
  for (const [key, field] of Object.entries(fields)) {
    fieldsConfig[key] = {
      type: newTypes[getNamedType(field.type).name] ? createFieldType(field.type, newTypes) : field.type,
      args: createArgumentConfig(field.args),
      deprecationReason: field.deprecationReason,
      description: field.description,
      astNode: field.astNode,
    };
  }
  return fieldsConfig;
}

function createArgumentConfig(args: GraphQLArgument[]) {
  const argsConfig: GraphQLFieldConfigArgumentMap = {};
  for (const arg of args) {
    argsConfig[arg.name] = {
      type: arg.type,
      defaultValue: arg.defaultValue,
      description: arg.description,
      astNode: arg.astNode,
    };
  }
  return argsConfig;
}

function isTypeToInclude(type: GraphQLNamedType) {
  return type.name !== "Query" &&
    type.name !== "Mutation" &&
    type.name !== "Subscription" &&
    getNamedType(type).name.slice(0, 2) !== "__" &&
    (!isScalarType(type) || (isScalarType(type) && !isSpecifiedScalarType(type)));
}

export function mergeRemoteSchemas({
  schemas,
  localSchema,
}: {
  schemas: GraphQLSchema[],
  localSchema?: GraphQLSchema,
}) {

  const newTypes: NewTypesMap = {};

  const allSchemas = localSchema ? [localSchema, ...schemas] : schemas;

  const queryTypes = allSchemas.map((schema) => ({ schema, type: schema.getQueryType() }));
  const query = mergeRootTypes({
    types: queryTypes.filter((argument) => argument.type) as ObjectTypeAndSchemaArray,
    newTypes,
  });

  const mutationTypes = allSchemas.map((schema) => ({ schema, type: schema.getMutationType() }));
  const mutation = mergeRootTypes({
    types: mutationTypes.filter((argument) => argument.type) as ObjectTypeAndSchemaArray,
    newTypes,
  });

  const typeNameToTypes: { [key: string]: NamedTypeAndSchemaArray } = {};
  if (localSchema) {
    for (const [key, type] of Object.entries(localSchema.getTypeMap())) {
      if (!typeNameToTypes[key]) {
        typeNameToTypes[key] = [];
      }
      typeNameToTypes[key].push({ schema: localSchema, type, replaceResolvers: false });
    }
  }
  for (const schema of schemas) {
    for (const [key, type] of Object.entries(schema.getTypeMap())) {
      if (!typeNameToTypes[key]) {
        typeNameToTypes[key] = [];
      }
      typeNameToTypes[key].push({ schema, type, replaceResolvers: true });
    }
  }

  for (const candidates of Object.values(typeNameToTypes)) {
    if (candidates.every(({ type }) => isTypeToInclude(type))) {
      if (candidates.every(({ type }) => isObjectType(type))) {
        const newType = mergeObjectTypes({
          types: candidates as ObjectTypeAndSchemaArray,
          newTypes,
        });
        newTypes[newType.name] = newType;
      } else {
        if (candidates.some(({ type }) => isObjectType(type))) {
          throw new Error(`Can't merge non-Object type ${candidates[0].type.name} with Object type of same name`);
        } else {
          const type = candidates[0].type;
          if (isUnionType(type)) {
            newTypes[type.name] = recreateUnionType(type, newTypes);
          } else if (isInterfaceType(type)) {
            newTypes[type.name] = recreateInterfaceType(type, newTypes);
          } else {
            newTypes[type.name] = type;
          }
        }
      }
    }
  }

  return new GraphQLSchema({
    query,
    mutation,
    types: Object.values(newTypes),
  });
}
