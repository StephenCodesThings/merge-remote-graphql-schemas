import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLFieldMap,
  GraphQLFieldConfigMap,
  GraphQLArgument,
  GraphQLFieldConfigArgumentMap,
  GraphQLNamedType,
  isObjectType,
  isSpecifiedScalarType,
  isScalarType,
  getNamedType,
  GraphQLOutputType,
  GraphQLNonNull,
  GraphQLList,
  isNonNullType,
  isListType,
  DirectiveNode,
  GraphQLFieldResolver,
  FieldNode,
} from 'graphql';
import { delegateToSchema } from 'graphql-tools';


type MergedTypesMap = { [key: string]: GraphQLObjectType };

function mergeObjectTypes(
  left: GraphQLObjectType, 
  right: GraphQLObjectType, 
  leftSchema: GraphQLSchema, 
  rightSchema: GraphQLSchema, 
  newTypes: MergedTypesMap
) {

  const leftMergeDirective = left.astNode && left.astNode.directives && left.astNode.directives.find((directive) => directive.name.value === "merge");
  const rightMergeDirective = right.astNode && right.astNode.directives && right.astNode.directives.find((directive) => directive.name.value === "merge");

  if (!leftMergeDirective || !rightMergeDirective) {
    throw new Error(`Can't merge ${left.name} and ${right.name} due to missing @merge directive(s)`)
  }

  const leftFields = getUndiscardedFields(left);
  const rightFields = getUndiscardedFields(right);

  for (const key of Object.keys(rightFields)) {
    if (leftFields[key]) {
      throw new Error(`Can't merge ${left.name} and ${right.name} due to duplicate field "${key}"`);
    }
  }

  return new GraphQLObjectType({
    name: right.name || left.name,
    description: right.description || left.description,
    astNode: right.astNode || left.astNode,
    fields: () => ({ 
      ...createFieldMapConfig(leftFields, newTypes, leftSchema, false, leftMergeDirective), 
      ...createFieldMapConfig(rightFields, newTypes, rightSchema, false, rightMergeDirective) 
    }),
  })
}

function mergeRootTypes(
  left: GraphQLObjectType,
  right: GraphQLObjectType,
  leftSchema: GraphQLSchema,
  rightSchema: GraphQLSchema,
  newTypes: MergedTypesMap
) {
  const leftFields = getUndiscardedFields(left);
  const rightFields = getUndiscardedFields(right);

  for (const key of Object.keys(rightFields)){
    if (leftFields[key]) {
      throw new Error(`Can't merge ${left.name} and ${right.name} due to duplicate field "${key}"`);
    }
  }

  return new GraphQLObjectType({
    name: right.name || left.name,
    description: right.description || left.description,
    astNode: right.astNode || left.astNode,
    fields: () => ({ 
      ...createFieldMapConfig(leftFields, newTypes, leftSchema, true), 
      ...createFieldMapConfig(rightFields, newTypes, rightSchema, true) 
    }),
  })
}

function recreateObjectType(type: GraphQLObjectType, schema: GraphQLSchema, mergedTypes: MergedTypesMap, root: boolean) {
  return new GraphQLObjectType({
    name: type.name,
    description: type.description,
    astNode: type.astNode,
    fields: () => createFieldMapConfig(getUndiscardedFields(type), mergedTypes, schema, root),
  })
}

function getUndiscardedFields(type: GraphQLObjectType) {
  const fields: GraphQLFieldMap<any, any> = {}
  for (const [key, value] of Object.entries(type.getFields())) {
    if (value.astNode && value.astNode.directives && value.astNode.directives.find((directive) => directive.name.value === "discard")) {
      console.log("discarding: ", key)
      continue;
    } else {
      fields[key] = value;
    }
  }
  return fields;
}

function createFieldMapConfig(
  fields: GraphQLFieldMap<any, any>,
  newTypes: MergedTypesMap,
  schema: GraphQLSchema,
  root: boolean,
  mergeDirective?: DirectiveNode,
): GraphQLFieldConfigMap<any, any> {
  const fieldsConfig: GraphQLFieldConfigMap<any, any> = {};
  for (const [key, value] of Object.entries(fields)) {
    fieldsConfig[key] = {
      type: newTypes[getNamedType(value.type).name] ? createFieldType(value.type, newTypes) : value.type,
      args: createArgumentConfig(value.args),
      resolve: root ? createRootResolver(schema) : createFieldResolver(schema, mergeDirective),
      subscribe: value.subscribe,
      deprecationReason: value.deprecationReason,
      description: value.description,
      astNode: value.astNode
    };
  }
  return fieldsConfig;
}

function createRootResolver(schema: GraphQLSchema): GraphQLFieldResolver<any, any> {
  return (parent, args, context, info) => {
    console.log("root resolver: ", info.fieldName)
    const request = delegateToSchema({
      schema,
      operation: info.operation.operation,
      fieldName: info.fieldName,
      args,
      context,
      info,
    });
    request.then((r) => console.log("root request", JSON.stringify(r))).catch((e) => console.log("i'm erroring", e));
    return request;
  };
}
console.log(createRootResolver);

function createFieldResolver(schema: GraphQLSchema, mergeDirective?: DirectiveNode): GraphQLFieldResolver<any, any> {
  const mergeQueryArgument = mergeDirective && mergeDirective.arguments && mergeDirective.arguments.find((arg) => arg.name.value === "query");
  const mergeQuery = mergeQueryArgument && mergeQueryArgument.value.kind === "StringValue" && mergeQueryArgument.value.value;

  if (mergeDirective && !mergeQuery) {
    throw new Error("Invalid merge directive");
  }

  return (parent, args, context, info) => {
    const responseKey = info.fieldNodes[0].alias
      ? info.fieldNodes[0].alias.value
      : info.fieldName;

    console.log("field resolver:", responseKey);

    const result = parent && parent[responseKey];
    if (result) {
      return result;
    } else {
      if (mergeQuery) {
        info = {
          ...info,
          fieldNodes: [{
            kind: "Field",
            name: {
              kind: "Name",
              value: mergeQuery
            },
            selectionSet: {
              kind: "SelectionSet",
              selections: info.fieldNodes
            }
          } as FieldNode]
        };
      }
      const request = delegateToSchema({
        schema,
        operation: "query",
        fieldName: mergeQuery || info.fieldName,
        args: mergeQuery ? { id: parent.id } : args,
        context,
        info,
      })
      request.then((r) => console.log("field resolver result:", JSON.stringify(r)));
      if (mergeDirective) {
        return request.then(result => result[responseKey]);
      } else {
        return request;
      }
    }
  }
}

function createFieldType(type: GraphQLOutputType, newTypes: MergedTypesMap): GraphQLOutputType {
  if (isNonNullType(type)) {
    return new GraphQLNonNull(createFieldType(type.ofType, newTypes));
  } else if (isListType(type)) {
    return new GraphQLList(createFieldType(type.ofType, newTypes));
  } else {
    return newTypes[type.name];
  }
}

function createArgumentConfig(args: GraphQLArgument[]) {
  const argsConfig: GraphQLFieldConfigArgumentMap = {};
  for (const arg of args) {
    argsConfig[arg.name] = {
      type: arg.type,
      defaultValue: arg.defaultValue,
      description: arg.description,
      astNode: arg.astNode
    }
  }
  return argsConfig;
}

export function mergeRemoteSchemas({ schemas }: { schemas: Array<GraphQLSchema> }) {

  const reducedSchema = schemas.reduce((left, right) => {
    const newTypes: MergedTypesMap = {};

    const rightQuery = right.getQueryType();
    const leftQuery = left.getQueryType();
    const query = rightQuery && leftQuery ? 
      mergeRootTypes(leftQuery, rightQuery, left, right, newTypes) : 
      rightQuery ? 
      recreateObjectType(rightQuery, right, newTypes, true) :
      leftQuery ? 
      recreateObjectType(leftQuery, left, newTypes, true) :
      undefined;

    const rightSubscription = right.getSubscriptionType();
    const leftSubscription = left.getSubscriptionType();
    const subscription = rightSubscription && leftSubscription ? 
      mergeRootTypes(leftSubscription, rightSubscription, left, right, newTypes) : 
      rightSubscription ? 
      recreateObjectType(rightSubscription, right, newTypes, true) :
      leftSubscription ?
      recreateObjectType(leftSubscription, left, newTypes, true) :
      undefined;

    const rightMutation = right.getMutationType();
    const leftMutation = left.getMutationType();
    const mutation = rightMutation && leftMutation ? 
      mergeRootTypes(leftMutation, rightMutation, left, right, newTypes) :
      rightMutation ?
      recreateObjectType(rightMutation, right, newTypes, true) :
      leftMutation ? 
      recreateObjectType(leftMutation, left, newTypes, true) :
      undefined;

    const leftTypeMap = left.getTypeMap();
    const rightTypeMap = right.getTypeMap();
    
    const types: GraphQLNamedType[] = [];
    for (const [key, leftType] of Object.entries(leftTypeMap)) {
      if (
        leftType != leftTypeMap.Query &&
        leftType != leftTypeMap.Mutation &&
        leftType != leftTypeMap.Subscription &&
        getNamedType(leftType).name.slice(0, 2) !== '__' &&
        (!isScalarType(leftType) || 
        (isScalarType(leftType) && !isSpecifiedScalarType(leftType)))
      ) {
        const rightType = rightTypeMap[key];
        if (isObjectType(leftType)) {
          if (rightType) {
            if (isObjectType(rightType)) {
              const mergedType = mergeObjectTypes(leftType, rightType, left, right, newTypes);
              newTypes[key] = mergedType;
              types.push(mergedType);
            } else {
              throw new Error(`Can't merge non-Object type ${rightType} with Object type of same name`);
            }
          } else {
            const newType = recreateObjectType(leftType, left, newTypes, false);
            newTypes[key] = newType;
            types.push(newType);
          }
        } else {
          if (!rightTypeMap[key]) {
            types.push(leftType);
          } else {
            types.push(leftType);
            console.warn(`Can't merge non-Object types ${leftType} and ${rightType}`);
          }
        }
      }
    }

    for (const [key, rightType] of Object.entries(rightTypeMap)) {
      if (
        !leftTypeMap[key] &&
        rightType != leftTypeMap.Query &&
        rightType != leftTypeMap.Mutation &&
        rightType != leftTypeMap.Subscription &&
        getNamedType(rightType).name.slice(0, 2) !== '__' &&
        (!isScalarType(rightType) || 
        (isScalarType(rightType) && !isSpecifiedScalarType(rightType)))
      ) {
        if (isObjectType(rightType)) {
          const newType = recreateObjectType(rightType, right, newTypes, false);
          newTypes[key] = newType;
          types.push(newType);
        } else {
          types.push(rightType);
        }
      }
    }

    return new GraphQLSchema({
      query,
      mutation,
      subscription,
      types
    });
  });

  return reducedSchema;
}
