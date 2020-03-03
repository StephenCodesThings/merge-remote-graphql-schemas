import { graphql, GraphQLScalarType } from "graphql";
import { GraphQLDate } from "graphql-iso-date";
import gql from "graphql-tag";
import { makeExecutableSchema, mergeSchemas } from "graphql-tools";
import { printSchema } from "graphql/utilities";
import "jasmine";
import { mergeRemoteSchemas } from "./merge-remote-schemas";

const combinedSchema = `type Bar {
  id: ID!
  foo: Foo!
  date: Date!
}

union Both = Foo | Bar

"""
A date string, such as 2007-12-03, compliant with the \`full-date\` format
outlined in section 5.6 of the RFC 3339 profile of the ISO 8601 standard for
representation of dates and times using the Gregorian calendar.
"""
scalar Date

type Foo implements FooB & FooA {
  id: ID!
  name: String!
  b: String!
  bars: [Bar!]!
  a: String!
}

interface FooA {
  a: String!
}

interface FooB {
  b: String!
}

type Mutation {
  updateFoo(input: UpdateFooInput!): Foo!
}

type Query {
  foo(id: ID!): Foo
  foos: [Foo!]!
  bar(id: ID!, date: Date!): Bar
}

interface Something {
  id: ID!
  bar: Bar!
}

input UpdateFooInput {
  id: ID!
  name: String!
}
`;

describe("mergeRemoteSchemas", () => {
  const fooSchema = makeExecutableSchema({
    typeDefs: gql`
      type Query {
        foo(id: ID!): Foo
        foos: [Foo!]!
      }

      type Mutation {
        updateFoo(input: UpdateFooInput!): Foo!
      }

      input UpdateFooInput {
        id: ID!
        name: String!
      }

      interface FooB {
        b: String!
      }

      type Foo implements FooB {
        id: ID!
        name: String!
        b: String!
      }
    `,
    resolvers: {
      Query: {
        foo: () => ({ id: "foo", name: "Name", date: new Date(0) }),
        foos: () => [{ id: "foo", name: "Name" }]
      },
      Mutation: {
        updateFoo: (_, { input: { id, name } }) => ({ id, name })
      }
    }
  });

  const barSchema = makeExecutableSchema({
    typeDefs: gql`
      type Query {
        bar(id: ID!, date: Date!): Bar
        foo(id: ID!): Foo
      }

      union Both = Foo | Bar

      interface Something {
        id: ID!
        bar: Bar!
      }

      type Bar {
        id: ID!
        foo: Foo!
        date: Date!
      }

      interface FooA {
        a: String!
      }

      type Foo implements FooA {
        id: ID!
        bars: [Bar!]!
        a: String!
      }

      scalar Date
    `,
    resolvers: {
      Query: {
        bar: () => ({ id: "bar", date: new Date(0), foo: { id: "foo" } }),
        foo: () => ({ id: "foo", bars: [{ id: "bar" }], a: "A" })
      },
      Foo: {
        bars: () => [{ id: "bar", date: new Date(0) }],
        a: () => "A"
      },
      Date: new GraphQLScalarType(GraphQLDate.toConfig())
    }
  });

  it("should merge passed in schemas", () => {
    const independentBarSchema = makeExecutableSchema({
      typeDefs: gql`
        type Query {
          bar(id: ID!): Bar
        }

        type Bar {
          id: ID!
        }
      `,
      resolvers: {
        Query: {
          bar: () => ({ id: "bar" })
        }
      }
    });

    const mergedSchema = mergeRemoteSchemas({
      schemas: [fooSchema, independentBarSchema]
    });
    expect(mergedSchema.toString()).toEqual(
      mergeSchemas({ schemas: [fooSchema, independentBarSchema] }).toString()
    );
  });

  it("should merge duplicate types", () => {
    const mergedSchema = mergeRemoteSchemas({
      schemas: [fooSchema, barSchema]
    });
    expect(printSchema(mergedSchema)).toEqual(combinedSchema);
  });

  it("should answer cross-schema queries", () => {
    const mergedSchema = mergeRemoteSchemas({
      schemas: [fooSchema, barSchema]
    });
    graphql(
      mergedSchema,
      `
        query testQuery($id: ID!, $date: Date!) {
          bar(id: $id, date: $date) {
            id
            date
            foo {
              id
              name
              bars {
                id
              }
              ... on FooA {
                a
              }
            }
          }
          foos {
            id
          }
        }
      `,
      undefined,
      undefined,
      {
        id: "bar",
        date: "1970-01-01"
      }
    )
      .then(result => {
        expect(result).toEqual({
          data: {
            bar: {
              id: "bar",
              date: "1970-01-01",
              foo: {
                id: "foo",
                name: "Name",
                bars: [{ id: "bar" }],
                a: "A"
              }
            },
            foos: [{ id: "foo" }]
          }
        });
      })
      .catch(() => fail());
  });

  it("should perform mutations", () => {
    const mergedSchema = mergeRemoteSchemas({
      schemas: [barSchema],
      localSchema: fooSchema
    });
    graphql(
      mergedSchema,
      `
        mutation updateFoo($input: UpdateFooInput!) {
          updateFoo(input: $input) {
            id
            name
          }
        }
      `,
      null,
      null,
      { input: { id: "foo", name: "something" } }
    )
      .then(result => {
        expect(result).toEqual({
          data: {
            updateFoo: {
              id: "foo",
              name: "something"
            }
          }
        });
      })
      .catch(() => fail());
  });
});
