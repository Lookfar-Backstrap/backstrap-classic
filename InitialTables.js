module.exports = {
  credentials: {
    object_type: 'credentials',
    relationships: [],
    properties: [
      {
        name: "password",
        data_type: "string",
        db_type: "VARCHAR(50)",
        required: true
      },
      {
        name: "salt",
        data_type: "string",
        db_type: "VARCHAR(50)",
        required: true
      },
      {
        name: "forgot_password_tokens",
        data_type: "array",
        required: false,
        nosql: true
      }
    ]
  },
  session: {
    object_type: 'session',
    relationships: [],
    properties: [
      {
        name: "is_anonymous",
        data_type: "boolean",
        required: false,
        default: false
      },
      {
        name: "token",
        data_type: "string",
        db_type: "VARCHAR(50)",
        required: true,
        unique: true
      },
      {
        name: "username",
        data_type: "string",
        db_type: "VARCHAR(50)",
        required: true
      },
      {
        name: "user_id",
        data_type: "string",
        db_type: "VARCHAR(50)",
        required: true
      },
      {
        name: "started_at",
        data_type: "date",
        db_type: "TIMESTAMP",
        required: true
      },
      {
        name: "client_info",
        data_type: "object",
        required: false,
        nosql: true
      },
      {
        name: "last_touch",
        data_type: "date",
        db_type: "TIMESTAMP",
        required: true
      }
    ]
  },
  bsuser: {
    object_type: 'bsuser',
    relationships: [
      {
        "relates_to": "session",
        "plural_name": "sessions",
        "relates_from": "bsuser",
        "plural_rev": "bsusers",
        "linking_table": "bsuser_session",
        "to_one": false
      },
      {
        "relates_to": "credentials",
        "plural_name": "credentials",
        "relates_from": "bsuser",
        "plural_rev": "bsusers",
        "foreign_table": "credentials",
        "to_one": true
      }
    ],
    properties: [
      {
        "name": "username",
        "data_type": "string",
        "db_type": "VARCHAR(50)",
        "required": true
      },
      {
        "name": "email",
        "data_type": "string",
        "db_type": "VARCHAR(50)",
        "required": true

      },
      {
        "name": "roles",
        "data_type": "array",
        "required": false
      },
      {
        "name": "first",
        "data_type": "string",
        "db_type": "VARCHAR(25)",
        "required": true
      },
      {
        "name": "last",
        "data_type": "string",
        "db_type": "VARCHAR(25)",
        "required": true
      }
    ]
  }
}