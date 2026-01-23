# MCP Server Design & Development Reference

## Quick Reference Summary

**Core Philosophy:** MCP servers are AI-user interfaces, not API wrappers. Design for outcomes, not endpoints.

**Key Rules:**

- Expose 5-15 focused tools maximum per server
- Each tool = one complete user capability
- Flatten inputs, use strong typing
- Return concise, structured outputs
- Name with service_domain_action pattern

---

## Architecture Fundamentals

### MCP Protocol Overview

```json
// Tool Definition Schema
{
  "name": "string",           // Required: unique tool identifier
  "description": "string",    // Required: LLM's understanding of tool
  "inputSchema": {            // Required: JSON Schema
    "type": "object",
    "properties": {},
    "required": []
  }
}

// Tool Call Request
{
  "method": "tools/call",
  "params": {
    "name": "tool_name",
    "arguments": { /* JSON matching inputSchema */ }
  }
}

// Tool Call Response
{
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Concise, LLM-optimized output"
      }
    ],
    "isError": false
  }
}
```

### Three MCP Primitives

**Tools:** Callable functions with typed inputs/outputs

```typescript
// Example: Weather tool
{
  name: "weather_get_forecast",
  description: "Get weather forecast for a location",
  inputSchema: {
    type: "object",
    properties: {
      location: { type: "string", description: "City name or ZIP code" },
      days: { type: "integer", minimum: 1, maximum: 7, default: 1 }
    },
    required: ["location"]
  }
}
```

**Resources:** Read-only data access points

```typescript
// Example: File resource
{
  uri: "file:///home/user/document.txt",
  name: "document.txt",
  description: "User document",
  mimeType: "text/plain"
}
```

**Prompts:** Pre-built workflow templates

```typescript
// Example: Report generation prompt
{
  name: "generate_monthly_report",
  description: "Generate comprehensive monthly performance report",
  arguments: {
    month: "2025-01",
    include_metrics: ["revenue", "users", "retention"]
  }
}
```

---

## Tool Design Patterns

### Pattern 1: Outcome-Oriented vs. Endpoint Wrapping

❌ **BAD: API Wrapper Approach**

```json
{
  "tools": [
    { "name": "get_user_by_email" },
    { "name": "get_user_orders" },
    { "name": "get_order_status" },
    { "name": "get_shipping_info" }
  ]
}
// LLM must chain 4 calls to answer "Where's my order?"
```

✅ **GOOD: Outcome-Oriented**

```json
{
  "tools": [
    {
      "name": "ecommerce_track_order",
      "description": "Track a customer's latest order status including shipping details and ETA",
      "inputSchema": {
        "type": "object",
        "properties": {
          "email": { "type": "string", "format": "email" }
        },
        "required": ["email"]
      }
    }
  ]
}
// LLM gets complete answer in 1 call
```

### Pattern 2: Input Schema Design

❌ **BAD: Nested, Complex Inputs**

```json
{
  "name": "search_documents",
  "inputSchema": {
    "type": "object",
    "properties": {
      "filters": {
        "type": "object",
        "properties": {
          "dateRange": { "type": "object" },
          "categories": { "type": "array" },
          "metadata": { "type": "object" }
        }
      }
    }
  }
}
```

✅ **GOOD: Flattened, Typed Inputs**

```json
{
  "name": "search_documents",
  "description": "Search documents by date, category, and keywords",
  "inputSchema": {
    "type": "object",
    "properties": {
      "start_date": {
        "type": "string",
        "format": "date",
        "description": "Earliest document date (YYYY-MM-DD)"
      },
      "end_date": {
        "type": "string",
        "format": "date",
        "description": "Latest document date (YYYY-MM-DD)"
      },
      "category": {
        "type": "string",
        "enum": ["legal", "finance", "hr", "technical"],
        "description": "Document category"
      },
      "keywords": {
        "type": "array",
        "items": { "type": "string" },
        "maxItems": 5
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 50,
        "default": 10
      }
    },
    "required": ["category"]
  }
}
```

### Pattern 3: Response Optimization

❌ **BAD: Raw Data Dump**

```json
{
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\"id\":42,\"status\":\"active\",\"tier\":3,\"last_payment_date\":\"2025-10-01\",\"email\":\"user@example.com\",\"created_at\":\"2024-01-15\",\"subscription_plan\":\"premium\",\"auto_renew\":true,\"payment_method\":\"credit_card\",\"billing_address\":{...},\"shipping_address\":{...}}"
      }
    ]
  }
}
```

✅ **GOOD: Concise, Contextualized Output**

```json
{
  "result": {
    "content": [
      {
        "type": "text",
        "text": "User #42 (user@example.com) is an active Tier 3 Premium subscriber. Last payment: 2025-10-01. Auto-renew enabled via credit card. Account created 2024-01-15."
      }
    ]
  }
}
```

### Pattern 4: Pagination for Large Datasets

```json
{
  "name": "list_transactions",
  "description": "List financial transactions with pagination",
  "inputSchema": {
    "type": "object",
    "properties": {
      "account_id": { "type": "string" },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100,
        "default": 20
      },
      "page_token": {
        "type": "string",
        "description": "Token from previous response to fetch next page"
      }
    },
    "required": ["account_id"]
  }
}
// Response includes:
// "next_page_token": "eyJwYWdlIjoyfQ==" if more results available
```

---

## Tool Naming Conventions

### Pattern: `[service]_[domain]_[action]`

```json
{
  "good_names": [
    "github_create_issue",
    "github_get_repository",
    "slack_send_message",
    "slack_list_channels",
    "jira_search_tickets",
    "aws_describe_instances",
    "database_query_analytics",
    "calendar_schedule_event"
  ],

  "bad_names": [
    "create_issue", // Too generic
    "process_data", // Vague
    "send_message", // Service ambiguous
    "get_info", // Non-specific
    "execute_action" // Meaningless
  ]
}
```

### Description Template

```json
{
  "name": "tool_name",
  "description": "[VERB] [OBJECT] for [CONTEXT/USE CASE]. When [USER INTENT], use this tool to [WHAT IT DOES]. Input constraints: [CONSTRAINTS]. Returns: [OUTPUT FORMAT]."
}

// Example:
{
  "name": "github_create_pull_request",
  "description": "Create a pull request in a GitHub repository. When the user wants to propose changes to code, use this tool to open a PR. Requires repository URL, source branch, target branch, and title. Returns PR URL and number."
}
```

---

## Schema Templates

### Basic Tool Schema

```typescript
interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, PropertySchema>;
    required?: string[];
  };
}

interface PropertySchema {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description?: string;
  format?: 'date' | 'date-time' | 'email' | 'uri' | 'uuid';
  enum?: any[];
  default?: any;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
}
```

### Response Schema

```typescript
interface MCPResponse {
  result: {
    content: Array<{
      type: 'text' | 'image' | 'resource';
      text?: string;
      data?: string; // base64 encoded for images
      mimeType?: string;
    }>;
    isError?: boolean;
    _meta?: {
      next_page_token?: string;
      total_count?: number;
      rate_limit_remaining?: number;
    };
  };
}
```

---

## Implementation Rules

### Rule 1: Tool Count and Focus

```yaml
MAX_TOOLS_PER_SERVER: 15
RECOMMENDED_TOOLS: 5-10
PRINCIPLE: 'One bounded context per server'
```

### Rule 2: Input Validation

```typescript
// REQUIRED: Validate all inputs before processing
function validateInput(input: any, schema: JSONSchema): boolean {
  // Use JSON Schema validator
  const validator = new Validator(schema);
  const valid = validator.validate(input);

  if (!valid) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `Invalid input: ${validator.errors.join(', ')}`,
        },
      ],
    };
  }
  return valid;
}
```

### Rule 3: Error Messages

```json
{
  "bad_error": {
    "isError": true,
    "content": [
      {
        "type": "text",
        "text": "Error 500: Internal server error"
      }
    ]
  },

  "good_error": {
    "isError": true,
    "content": [
      {
        "type": "text",
        "text": "User not found: 'john@example.com'. Please verify the email address or check if the user exists in your organization."
      }
    ]
  }
}
```

### Rule 4: Security Requirements

```typescript
interface SecurityRules {
  // Never expose secrets
  NO_SECRETS_IN_OUTPUT: true;

  // Require confirmation for destructive actions
  DESTRUCTIVE_ACTIONS_REQUIRE_CONFIRMATION: true;

  // Implement least privilege
  GRANULAR_PERMISSIONS: {
    read: ['get_user', 'list_resources'];
    write: ['create_resource', 'update_resource'];
    admin: ['delete_resource', 'configure_system'];
  };

  // Audit logging
  AUDIT_ALL_TOOL_CALLS: {
    timestamp: true;
    user_id: true;
    tool_name: true;
    arguments: true; // scrub secrets
    result: true;
    duration_ms: true;
  };
}
```

---

## Anti-Patterns to Avoid

### ❌ Anti-Pattern 1: Over-Abstraction

```json
{
  "name": "execute_query",
  "description": "Execute any SQL query",
  "inputSchema": {
    "properties": {
      "query": { "type": "string" }
    }
  }
}
// PROBLEM: Too powerful, no guardrails, SQL injection risk
```

### ❌ Anti-Pattern 2: Stateless Multi-Call Workflows

```json
{
  "tools": [
    { "name": "step1_initialize" },
    { "name": "step2_configure" },
    { "name": "step3_execute" },
    { "name": "step4_finalize" }
  ]
}
// PROBLEM: LLM must manage state, prone to failure
```

### ❌ Anti-Pattern 3: Unclear Tool Boundaries

```json
{
  "name": "manage_user_account",
  "description": "Do anything with user accounts"
  // PROBLEM: Vague, LLM won't know when to use
}
```

### ❌ Anti-Pattern 4: Excessive Context Consumption

```json
{
  "result": {
    "content": [
      {
        "type": "text",
        "text": "[500KB of log output]" // Wastes context window
      }
    ]
  }
}
```

---

## Code Examples

### Python MCP Server Skeleton

```python
from typing import Any, Dict, List
from pydantic import BaseModel, Field
import json

class MCPTool:
    def __init__(self, name: str, description: str, schema: Dict[str, Any]):
        self.name = name
        self.description = description
        self.input_schema = schema

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "inputSchema": self.input_schema
        }

class MCPServer:
    def __init__(self, name: str):
        self.name = name
        self.tools: Dict[str, MCPTool] = {}

    def register_tool(self, tool: MCPTool):
        self.tools[tool.name] = tool

    def list_tools(self) -> List[Dict[str, Any]]:
        return [tool.to_dict() for tool in self.tools.values()]

    async def call_tool(self, name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        tool = self.tools.get(name)
        if not tool:
            return {
                "result": {
                    "content": [{"type": "text", "text": f"Tool '{name}' not found"}],
                    "isError": True
                }
            }

        try:
            result = await self._execute_tool(tool, arguments)
            return {
                "result": {
                    "content": [{"type": "text", "text": result}],
                    "isError": False
                }
            }
        except Exception as e:
            return {
                "result": {
                    "content": [{"type": "text", "text": f"Error: {str(e)}"}],
                    "isError": True
                }
            }

    async def _execute_tool(self, tool: MCPTool, arguments: Dict[str, Any]) -> str:
        # Validate input schema
        # Execute tool logic
        # Return formatted output
        pass

# Example usage
server = MCPServer("weather_server")

get_weather = MCPTool(
    name="weather_get_current",
    description="Get current weather conditions for a location",
    schema={
        "type": "object",
        "properties": {
            "location": {
                "type": "string",
                "description": "City name or ZIP code"
            },
            "unit": {
                "type": "string",
                "enum": ["celsius", "fahrenheit"],
                "default": "celsius"
            }
        },
        "required": ["location"]
    }
)

server.register_tool(get_weather)
```

### TypeScript/Node.js MCP Server

```typescript
interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

interface MCPRequest {
  method: string;
  params: {
    name?: string;
    arguments?: Record<string, any>;
  };
}

interface MCPResponse {
  result: {
    content: Array<{
      type: string;
      text?: string;
    }>;
    isError: boolean;
  };
}

class MCPServer {
  private tools: Map<string, MCPTool> = new Map();

  registerTool(tool: MCPTool): void {
    this.tools.set(tool.name, tool);
  }

  listTools(): MCPTool[] {
    return Array.from(this.tools.values());
  }

  async handleRequest(request: MCPRequest): Promise<MCPResponse> {
    if (request.method === 'tools/list') {
      return {
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(this.listTools()),
            },
          ],
          isError: false,
        },
      };
    }

    if (request.method === 'tools/call') {
      const { name, arguments: args } = request.params;
      const tool = this.tools.get(name!);

      if (!tool) {
        return {
          result: {
            content: [
              {
                type: 'text',
                text: `Tool '${name}' not found`,
              },
            ],
            isError: true,
          },
        };
      }

      try {
        const result = await this.executeTool(tool, args || {});
        return {
          result: {
            content: [{ type: 'text', text: result }],
            isError: false,
          },
        };
      } catch (error) {
        return {
          result: {
            content: [
              {
                type: 'text',
                text: `Error: ${error.message}`,
              },
            ],
            isError: true,
          },
        };
      }
    }

    return {
      result: {
        content: [
          {
            type: 'text',
            text: `Unknown method: ${request.method}`,
          },
        ],
        isError: true,
      },
    };
  }

  private async executeTool(tool: MCPTool, args: Record<string, any>): Promise<string> {
    // Implement tool logic
    return 'Tool executed successfully';
  }
}

// Example tool
const searchDocuments: MCPTool = {
  name: 'docs_search',
  description: 'Search documents by keywords and category',
  inputSchema: {
    type: 'object',
    properties: {
      keywords: {
        type: 'array',
        items: { type: 'string' },
        description: 'Search keywords',
      },
      category: {
        type: 'string',
        enum: ['technical', 'legal', 'hr', 'finance'],
        description: 'Document category',
      },
      limit: {
        type: 'number',
        minimum: 1,
        maximum: 50,
        default: 10,
      },
    },
    required: ['category'],
  },
};

const server = new MCPServer();
server.registerTool(searchDocuments);
```

---

## Development Checklist

### Design Phase

- [ ] Define bounded context for this server
- [ ] Identify 5-15 core user capabilities
- [ ] Draft tool names using `[service]_[domain]_[action]` pattern
- [ ] Write clear descriptions with usage guidance
- [ ] Design flat, typed input schemas
- [ ] Plan response formats (prefer concise text over raw JSON)

### Implementation Phase

- [ ] Implement JSON Schema validation
- [ ] Add comprehensive error messages
- [ ] Implement pagination for list operations
- [ ] Add audit logging
- [ ] Implement rate limiting
- [ ] Add confirmation prompts for destructive actions
- [ ] Secure secrets and credentials
- [ ] Test with multiple LLM clients

### Testing Phase

- [ ] Test each tool with valid inputs
- [ ] Test with invalid inputs (verify error messages)
- [ ] Test edge cases (empty results, large datasets)
- [ ] Test with real LLM agents (Claude, GPT-4, etc.)
- [ ] Verify token efficiency of outputs
- [ ] Security audit (permissions, input sanitization)
- [ ] Performance test (latency, concurrent calls)

---

## Quick Reference Patterns

### Common Tool Templates

#### Search/Query Tool

```json
{
  "name": "resource_search",
  "description": "Search [resources] by [criteria]. Returns [what].",
  "inputSchema": {
    "properties": {
      "query": { "type": "string" },
      "filters": { "type": "object" },
      "limit": { "type": "integer", "default": 10 }
    },
    "required": ["query"]
  }
}
```

#### CRUD - Create

```json
{
  "name": "resource_create",
  "description": "Create a new [resource]. Returns created [resource] details with ID.",
  "inputSchema": {
    "properties": {
      "name": { "type": "string" },
      "properties": { "type": "object" },
      "tags": { "type": "array", "items": { "type": "string" } }
    },
    "required": ["name"]
  }
}
```

#### CRUD - Read

```json
{
  "name": "resource_get",
  "description": "Get [resource] by ID. Returns [resource] details.",
  "inputSchema": {
    "properties": {
      "id": { "type": "string", "description": "Unique resource identifier" }
    },
    "required": ["id"]
  }
}
```

#### CRUD - Update

```json
{
  "name": "resource_update",
  "description": "Update [resource] by ID. Only provided fields are updated. Returns updated [resource].",
  "inputSchema": {
    "properties": {
      "id": { "type": "string" },
      "updates": { "type": "object" }
    },
    "required": ["id", "updates"]
  }
}
```

#### CRUD - Delete

```json
{
  "name": "resource_delete",
  "description": "Delete [resource] by ID. This action is irreversible. Returns confirmation message.",
  "inputSchema": {
    "properties": {
      "id": { "type": "string" },
      "confirm": {
        "type": "boolean",
        "description": "Must be true to confirm deletion"
      }
    },
    "required": ["id", "confirm"]
  }
}
```

---

## Performance Optimization

### Token Efficiency Rules

```yaml
MAX_RESPONSE_TOKENS: 2000 # Keep responses concise
PAGINATION_THRESHOLD: 10 # Paginate after N items
PREFER_SUMMARY_OVER_FULL: true # Return summaries, not full records
```

### Response Optimization Examples

```json
// INEFFICIENT: Full record dump
{
  "text": "{\"id\":1,\"name\":\"Project X\",\"description\":\"...\",\"owner\":\"...\",\"created_at\":\"...\",\"updated_at\":\"...\",\"status\":\"...\",\"priority\":\"...\",\"tags\":[...]}"
}

// EFFICIENT: Focused summary
{
  "text": "Project #1 'Project X' is in progress (Priority: High). Owned by Alice. Created 2025-01-15. Last updated 2025-01-20."
}
```

### Caching Strategies

```typescript
// Cache frequently accessed read-only data
const CACHE_TTL_SECONDS = 300; // 5 minutes

interface CacheEntry {
  data: any;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();

function getCached(key: string): any | null {
  const entry = cache.get(key);
  if (!entry) return null;

  if (Date.now() - entry.timestamp > CACHE_TTL_SECONDS * 1000) {
    cache.delete(key);
    return null;
  }

  return entry.data;
}
```

---

## Security Best Practices

### Input Sanitization

```python
import re

def sanitize_user_input(input_string: str) -> str:
    # Remove potential SQL injection patterns
    if re.search(r'(\'|\"|;|--|\/\*|\*\/|xp_|sp_)', input_string):
        raise ValueError("Potentially malicious input detected")

    # Limit length
    if len(input_string) > 10000:
        raise ValueError("Input too long")

    return input_string.strip()
```

### Permission Scoping

```typescript
enum Permission {
  READ = 'read',
  WRITE = 'write',
  ADMIN = 'admin',
}

interface UserContext {
  userId: string;
  permissions: Permission[];
  allowedResources: string[];
}

function checkPermission(
  context: UserContext,
  requiredPermission: Permission,
  resourceId: string,
): boolean {
  if (!context.permissions.includes(requiredPermission)) {
    return false;
  }

  if (requiredPermission === Permission.READ) {
    return context.allowedResources.includes(resourceId);
  }

  return true; // Admin or write permissions
}
```

### Audit Logging

```python
import logging
from datetime import datetime
import json

audit_logger = logging.getLogger("mcp_audit")

def log_tool_call(
  tool_name: str,
  user_id: str,
  arguments: dict,
  result: dict,
  duration_ms: int,
  is_error: bool
):
  # Scrub secrets from arguments
  safe_args = scrub_secrets(arguments)

  log_entry = {
    "timestamp": datetime.utcnow().isoformat(),
    "tool_name": tool_name,
    "user_id": user_id,
    "arguments": safe_args,
    "is_error": is_error,
    "duration_ms": duration_ms,
    "result_keys": list(result.keys()) if result else []
  }

  audit_logger.info(json.dumps(log_entry))

def scrub_secrets(data: dict) -> dict:
  SECRET_KEYS = {'password', 'token', 'api_key', 'secret', 'credit_card'}

  scrubbed = data.copy()
  for key in list(scrubbed.keys()):
    if any(secret in key.lower() for secret in SECRET_KEYS):
      scrubbed[key] = "***REDACTED***"
    elif isinstance(scrubbed[key], dict):
      scrubbed[key] = scrub_secrets(scrubbed[key])

  return scrubbed
```

---

## Error Handling Patterns

### Graceful Degradation

```json
{
  "scenario": "Partial service failure",
  "response": {
    "isError": false,
    "content": [
      {
        "type": "text",
        "text": "Successfully retrieved 8 of 10 requested items. 2 items are temporarily unavailable due to maintenance. Available items: [list of items]. Please try again later for full results."
      }
    ]
  }
}
```

### Rate Limiting Response

```json
{
  "scenario": "Rate limit exceeded",
  "response": {
    "isError": true,
    "content": [
      {
        "type": "text",
        "text": "Rate limit exceeded. You have made 10 calls in the last minute. Limit: 10 calls/minute. Please wait 30 seconds before making another call. Your remaining quota: 0 calls."
      }
    ]
  }
}
```

### Not Found Response

```json
{
  "scenario": "Resource not found",
  "response": {
    "isError": false,
    "content": [
      {
        "type": "text",
        "text": "No resource found matching ID 'abc123'. Please verify the ID or search the resource list."
      }
    ]
  }
}
```

---

## Advanced Features

### Server-Side Context Management

```typescript
class ContextManager {
  private sessions: Map<string, any> = new Map();

  setContext(sessionId: string, context: any): void {
    this.sessions.set(sessionId, {
      ...context,
      updatedAt: Date.now()
    });
  }

  getContext(sessionId: string): any | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    // Expire after 30 minutes of inactivity
    if (Date.now() - session.updatedAt > 30 * 60 * 1000) {
      this.sessions.delete(sessionId);
      return null;
    }

    return session;
  }

  // Use for keeping "active project" or similar state
}

// Example: Tool that uses server-side context
{
  name: "project_create_task",
  description: "Create a task in the currently active project. Use 'project_set_active' first to select a project.",
  inputSchema: {
    "properties": {
      "title": { "type": "string" },
      "description": { "type": "string" },
      "priority": { "type": "string", "enum": ["low", "medium", "high"] }
    },
    "required": ["title"]
  }
}
```

### Streaming Responses

```typescript
interface StreamingTool {
  name: string;
  canStream: true;
  executeWithStream: (
    arguments: Record<string, any>,
    onChunk: (chunk: string) => void,
  ) => Promise<void>;
}

// Example: Long-running report generation
async function generateReportStream(
  args: Record<string, any>,
  onChunk: (chunk: string) => void,
): Promise<void> {
  onChunk('Generating report...\n');

  const sections = ['Executive Summary', 'Metrics', 'Analysis', 'Recommendations'];
  for (const section of sections) {
    onChunk(`Processing ${section}...\n`);
    await generateSection(section, onChunk);
  }

  onChunk('\nReport generation complete.');
}
```

---

## Testing Strategies

### Unit Test Template

```python
import pytest
from unittest.mock import AsyncMock, patch

class TestMCPTools:
    @pytest.mark.asyncio
    async def test_tool_valid_input(self):
        """Test tool with valid input returns correct output"""
        result = await server.call_tool("weather_get_current", {
            "location": "New York",
            "unit": "fahrenheit"
        })

        assert not result["result"]["isError"]
        assert "New York" in result["result"]["content"][0]["text"]
        assert "°F" in result["result"]["content"][0]["text"]

    @pytest.mark.asyncio
    async def test_tool_invalid_input(self):
        """Test tool with invalid input returns helpful error"""
        result = await server.call_tool("weather_get_current", {
            "location": ""  # Empty string should fail
        })

        assert result["result"]["isError"]
        assert "location" in result["result"]["content"][0]["text"].lower()

    @pytest.mark.asyncio
    async def test_tool_not_found(self):
        """Test requesting non-existent tool"""
        result = await server.call_tool("nonexistent_tool", {})

        assert result["result"]["isError"]
        assert "not found" in result["result"]["content"][0]["text"].lower()

    @pytest.mark.asyncio
    async def test_token_efficiency(self):
        """Ensure response is concise and token-efficient"""
        result = await server.call_tool("user_get_profile", {
            "user_id": "123"
        })

        response_text = result["result"]["content"][0]["text"]
        # Response should be under 500 tokens (~2000 chars)
        assert len(response_text) < 2000
        # Should be formatted for LLM, not raw JSON
        assert "{" not in response_text or "User" in response_text
```

### Integration Test Template

```typescript
import { describe, it, expect } from 'vitest';
import { MCPServer } from './server';

describe('MCP Server Integration', () => {
  const server = new MCPServer('test_server');

  it('should handle tool discovery', async () => {
    const response = await server.handleRequest({
      method: 'tools/list',
      params: {},
    });

    expect(response.result.isError).toBe(false);
    const tools = JSON.parse(response.result.content[0].text);
    expect(tools.length).toBeGreaterThan(0);
    expect(tools[0].name).toBeDefined();
    expect(tools[0].description).toBeDefined();
    expect(tools[0].inputSchema).toBeDefined();
  });

  it('should execute tool successfully', async () => {
    const response = await server.handleRequest({
      method: 'tools/call',
      params: {
        name: 'test_tool',
        arguments: { input: 'test' },
      },
    });

    expect(response.result.isError).toBe(false);
    expect(response.result.content[0].text).toBeTruthy();
  });
});
```

---

## Versioning Strategy

### Semantic Versioning for MCP Servers

```
MAJOR.MINOR.PATCH

MAJOR: Breaking changes to tool names, input/output schemas
MINOR: New tools added, backward-compatible changes
PATCH: Bug fixes, documentation updates
```

### Version Negotiation

```typescript
interface ServerCapabilities {
  version: string;
  supportedTools: string[];
  features: {
    streaming?: boolean;
    pagination?: boolean;
    contextManagement?: boolean;
  };
}

class MCPServer {
  private capabilities: ServerCapabilities = {
    version: '1.2.0',
    supportedTools: [],
    features: {
      pagination: true,
    },
  };

  getCapabilities(): ServerCapabilities {
    return this.capabilities;
  }

  // Client can check compatibility before making calls
  isCompatible(clientVersion: string): boolean {
    // Implement version compatibility logic
    return true;
  }
}
```

### Backward Compatibility Rules

```yaml
DEPRECATION_POLICY:
  MAJOR_VERSION_CHANGE: 'Announce 3 months in advance'
  MINOR_VERSION_CHANGE: 'Backward compatible, add new tools only'
  PATCH_VERSION_CHANGE: 'Bug fixes only, no API changes'

BREAKING_CHANGES_REQUIRE:
  - New tool name
  - Version bump (MAJOR)
  - Migration guide
  - Support period for old version
```

---

## Monitoring and Observability

### Metrics to Track

```typescript
interface MCPMetrics {
  // Request metrics
  totalCalls: number;
  callsPerTool: Record<string, number>;
  averageLatencyMs: number;

  // Error metrics
  errorRate: number;
  errorsByType: Record<string, number>;

  // Usage metrics
  uniqueUsers: number;
  callsPerUser: Record<string, number>;

  // Performance metrics
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;

  // Token metrics
  averageInputTokens: number;
  averageOutputTokens: number;
  totalTokensConsumed: number;
}

class MetricsCollector {
  private metrics: MCPMetrics = {
    totalCalls: 0,
    callsPerTool: {},
    averageLatencyMs: 0,
    errorRate: 0,
    errorsByType: {},
    uniqueUsers: 0,
    callsPerUser: {},
    p50LatencyMs: 0,
    p95LatencyMs: 0,
    p99LatencyMs: 0,
    averageInputTokens: 0,
    averageOutputTokens: 0,
    totalTokensConsumed: 0,
  };

  recordCall(toolName: string, userId: string, latencyMs: number, isError: boolean) {
    this.metrics.totalCalls++;
    this.metrics.callsPerTool[toolName] = (this.metrics.callsPerTool[toolName] || 0) + 1;
    this.metrics.callsPerUser[userId] = (this.metrics.callsPerUser[userId] || 0) + 1;

    // Update latency percentiles
    // Update error rate
    // etc.
  }

  getMetrics(): MCPMetrics {
    return { ...this.metrics };
  }
}
```

### Health Check Endpoint

```json
{
  "method": "server/health",
  "response": {
    "status": "healthy",
    "version": "1.2.0",
    "uptime": 86400,
    "activeConnections": 5,
    "metrics": {
      "totalCalls": 1000,
      "errorRate": 0.02,
      "averageLatencyMs": 150
    }
  }
}
```

---

## Conclusion

This reference guide provides the essential patterns, schemas, and best practices for building effective MCP servers. Key takeaways:

1. **Design for AI, not humans** - Think in terms of outcomes, not endpoints
2. **Keep it simple** - 5-15 focused tools per server
3. **Constrain inputs** - Use flat, typed schemas with enums and defaults
4. **Optimize outputs** - Return concise, contextualized results
5. **Name clearly** - Use `[service]_[domain]_[action]` pattern
6. **Secure by default** - Implement least privilege, audit logging, and confirmation for dangerous actions
7. **Measure everything** - Track usage, errors, latency, and token consumption

For additional resources:

- Official MCP Specification: https://modelcontextprotocol.io
- Community examples and discussions
- Reference implementations from Anthropic and community
