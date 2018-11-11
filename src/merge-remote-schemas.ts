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
} from 'graphql';


type MergedTypesMap = { [key: string]: GraphQLObjectType };

function mergeObjectTypes(left: GraphQLObjectType, right: GraphQLObjectType, newTypes: MergedTypesMap) {

  const main = (left.astNode && left.astNode.directives && left.astNode.directives.find((directive) => directive.name.value === "merge")) ?
    right :
    left;

  const combinedFields = getUndiscardedFields(left);

  for (const [key, value] of Object.entries(right.getFields())){
    if (value.astNode && value.astNode.directives && value.astNode.directives.find((directive) => directive.name.value === "discard")) {
      continue;
    } else {
      if (combinedFields[key]) {
        throw new Error(`Can't merge ${left.name} and ${right.name} due to duplicate field ${key}`);
      } else {
        combinedFields[key] = value;
      }
    }
  }

  return new GraphQLObjectType({
    name: main.name,
    description: main.description,
    astNode: main.astNode,
    fields: () => createFieldMapConfig(combinedFields, newTypes),
  })
}



function recreateObjectType(type: GraphQLObjectType, mergedTypes: MergedTypesMap) {
  return new GraphQLObjectType({
    name: type.name,
    description: type.description,
    astNode: type.astNode,
    fields: () => createFieldMapConfig(getUndiscardedFields(type), mergedTypes),
  })
}

function getUndiscardedFields(type: GraphQLObjectType) {
  const fields: GraphQLFieldMap<any, any> = {}
  for (const [key, value] of Object.entries(type.getFields())){
    if (value.astNode && value.astNode.directives && value.astNode.directives.find((directive) => directive.name.value === "discard")) {
      continue;
    } else {
      fields[key] = value;
    }
  }
  return fields;
}

function createFieldMapConfig(
  fields: GraphQLFieldMap<any, any>,
  newTypes: MergedTypesMap
): GraphQLFieldConfigMap<any, any> {
  const fieldsConfig: GraphQLFieldConfigMap<any, any> = {};
  for (const [key, value] of Object.entries(fields)) {
    fieldsConfig[key] = {
      type: newTypes[getNamedType(value.type).name] ? createFieldType(value.type, newTypes) : value.type,
      args: createArgumentConfig(value.args),
      resolve: value.resolve,
      subscribe: value.subscribe,
      deprecationReason: value.deprecationReason,
      description: value.description,
      astNode: value.astNode
    };
  }
  return fieldsConfig;
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
  const filteredSchemas = schemas.map((schema) => {
    return schema;
  });

  const reducedSchema = filteredSchemas.reduce((left, right) => {
    const newTypes: MergedTypesMap = {};

    const rightQuery = right.getQueryType();
    const leftQuery = left.getQueryType();
    const query = rightQuery && leftQuery ? 
      mergeObjectTypes(rightQuery, leftQuery, newTypes) : 
      ((rightQuery || leftQuery) && recreateObjectType(rightQuery! || leftQuery!, newTypes));

    const rightSubscription = right.getSubscriptionType();
    const leftSubscription = left.getSubscriptionType();
    const subscription = rightSubscription && leftSubscription ? 
      mergeObjectTypes(rightSubscription, leftSubscription, newTypes) : 
      ((rightSubscription || leftSubscription) && recreateObjectType(rightSubscription! || leftSubscription!, newTypes));

    const rightMutation = right.getMutationType();
    const leftMutation = left.getMutationType();
    const mutation = rightMutation && leftMutation ? 
      mergeObjectTypes(rightMutation, leftMutation, newTypes) :
      ((rightMutation || leftMutation) && recreateObjectType(rightMutation! || leftMutation!, newTypes));

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
              const mergedType = mergeObjectTypes(leftType, rightType, newTypes);
              newTypes[key] = mergedType;
              types.push(mergedType);
            } else {
              throw new Error(`Can't merge non-Object type ${rightType}`);
            }
          } else {
            const newType = recreateObjectType(leftType, newTypes);
            newTypes[key] = newType;
            types.push(newType);
          }
        } else {
          if (!rightTypeMap[key]) {
            types.push(leftType);
          } else {
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
          const newType = recreateObjectType(rightType, newTypes);
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
