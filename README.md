# merge-remote-graphql-schemas

This utility merges remote GraphQL schemas into a single unified schema, including merging types.
It's good practice to split your schema up by concern, which is easy enough to do within a single GraphQL service using the `extend` keyword.

For example, given this schema:

```
type Query {
  book(id: ID!): Book
  review(id: ID!): Review
}

type Review {
  id: ID!
  title: String!
  book: Book!
}

type Book {
  id: ID!
  title: String
  author: String
  reviews: [Review!]!
}
```

You might want to split it up by `Book` and `Review` concerns:

```
# Book schema
extend type Query {
  book(id: ID!): Book
}

type Book {
  id: ID!
  title: String
  author: String
}
```

```
# Review schema
extend type Query {
  review(id: ID!): Review
}

type Review {
  id: ID!
  title: String!
  book: Book!
}

extend type Book {
  reviews: [Review!]!
}
```

However, it's not as easy to do this across remote GraphQL schemas since you can't extend types that exist in other GraphQL services. Usually, in order to combine remote schemas that interact with each other you would need to write resolvers in your GraphQL gateway that perform the needed mappings. This library does that mapping automatically. 

## Installation

```
npm install --save merge-remote-graphql-schemas
```

## Usage

In order to merge types across remote schemas there needs to be a known entry point to query information about those types in each schema. By convention this library assumes for each merged type there is a top level query that is named after the type in lowercase that accepts an id argument and returns that type. So the `Book` type needs to have a `book(id: ID!): Book` query resolver.

If a type doesn't have any cross-schema interactions then it doesn't need to meet this requirement. 

Using the example from earlier, your GraphQL servers would expose these schemas:

```
# Book GraphQL Service
type Query {
  book(id: ID!): Book
}

type Book {
  id: ID!
  title: String
  author: String
}
```

```
# Review GraphQL Service
type Query {
  book(id: ID!): Book
  review(id: ID!): Review
}

type Review {
  id: ID!
  title: String!
  book: Book!
}

type Book {
  id: ID!
  reviews: [Review!]!
}
```

The Review service only needs to know about Books as far as the relationships between Books and Reviews and the Book service doesn't need to know about Reviews at all.

The following example uses ApolloServer to run a GraphQL server. The schema provided to ApolloServer is created by `mergeRemoteSchemas` from two remote GraphQL services. 

```js
const { ApolloServer, makeRemoteExecutableSchema, introspectSchema } = require('apollo-server');
const { HttpLink } = require('apollo-link-http');
const fetch = require('node-fetch');
const { mergeRemoteSchemas } = require('merge-remote-graphql-schemas');

async function createRemoteExecutableSchema(uri) {

  const link = new HttpLink({
    uri,
    fetch,
  });

  const schema = makeRemoteExecutableSchema({
    schema: await introspectSchema(httpLink),
    link,
  });

  return schema;
};

Promise.all(['http://{BOOK_SERVICE}/graphql', 'http://{REVIEW_SERVICE}/graphql'].map(createRemoteExecutableSchema))
  .then((schemas) => {
    const server = new ApolloServer({ schema: mergeRemoteSchemas({ schemas }) }); // Merge the remote schemas together and pass the result to ApolloServer

    server.listen().then(({ url }) => {
      console.log(`🚀  Server ready at ${url}`);
    });
  });
```

The stitched together schema exposed by this service would be: 
```
type Query {
  book(id: ID!): Book
  review(id: ID!): Review
}

type Review {
  id: ID!
  title: String!
  book: Book!
}

type Book {
  id: ID!
  title: String
  author: String
  reviews: [Review!]!
}
```
