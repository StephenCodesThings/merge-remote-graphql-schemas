import { graphql } from "graphql";
import gql from "graphql-tag";
import { makeExecutableSchema, mergeSchemas } from "graphql-tools";
import { printSchema } from "graphql/utilities";
import "jasmine";
import { mergeRemoteSchemas } from "./merge-remote-schemas";

const combinedSchema = `type Bar {
  id: ID!
  foo: Foo!
}

type Foo {
  id: ID!
  name: String!
  bars: [Bar!]!
}

type Query {
  foo(id: ID!): Foo
  bar(id: ID!): Bar
}
`;

describe("mergeRemoteSchemas", () => {

  const fooSchema = makeExecutableSchema({
    typeDefs: gql`
      type Query {
        foo(id: ID!): Foo
      }

      type Foo {
        id: ID!
        name: String!
      }
    `,
    resolvers: {
      Query: {
        foo: () => ({ id: "foo", name: "Name" }),
      },
    },
  });

  const directiveSchema = makeExecutableSchema({
    typeDefs: gql`
      type Query {
        bar(id: ID!): Bar
        foo(id: ID!): Foo
      }

      type Bar {
        id: ID!
        foo: Foo!
      }

      type Foo {
        id: ID!
        bars: [Bar!]!
      }
    `,
    resolvers: {
      Query: {
        bar: () => ({ id: "bar", foo: { id: "foo" }}),
        foo: () => ({ id: "foo", bars: [{ id: "bar" }] }),
      },
      Foo: {
        bars: () => [{ id: "bar" }],
      },
    },
  });

  it("should merge passed in schemas", () => {
    const barSchema = makeExecutableSchema({
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
          bar: () => ({ id: "bar" }),
        },
      },
    });

    const mergedSchema = mergeRemoteSchemas({ schemas: [fooSchema, barSchema ]});
    expect(mergedSchema.toString()).toEqual(mergeSchemas({ schemas: [fooSchema, barSchema]}).toString());
  });

  it("should follow directives", () => {

    const mergedSchema = mergeRemoteSchemas({ schemas: [fooSchema, directiveSchema]});
    expect(printSchema(mergedSchema)).toEqual(combinedSchema);
  });

  it("should answer cross-schema queries", () => {

    const mergedSchema = mergeRemoteSchemas({ schemas: [fooSchema, directiveSchema]});
    graphql(mergedSchema, `
      query {
        bar(id: "bar") {
          id
          foo {
            id
            name
            bars {
              id
            }
          }
        }
      }
    `)
      .then((result) => {
        expect(result).toEqual({
          data: {
            bar: {
              id: "bar",
              foo: {
                id: "foo",
                name: "Name",
                bars: [{ id: "bar" }],
              },
            },
          },
        });
      })
      .catch(() => fail());
  });
});
