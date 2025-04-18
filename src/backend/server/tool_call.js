const { ReActAgent, State } = require("./agent.js")
const { utils, global } = require('../modules/globals.js')
const { pushMessage, getMessages, envMessage, clearMessages, loadMessages, setTag } = require('../server/llm_service.js');
const { MCPClient } = require('./mcp_client.js')
const JSON5 = require("json5")
const fs = require('fs');
const os = require('os');
const path = require('path');

class ToolCall extends ReActAgent {

  async init_mcp() {
    try {
      const configs = utils.getConfig("mcp_server");
      for (const name in configs) {
        if (Object.hasOwnProperty.call(configs, name)) {
          const config = configs[name];
          await this.mcp_client.setTransport({ name, config });
        }
      }
      await this.mcp_client.connectMCP();
      return this.mcp_client.mcp_prompt;
    } catch (error) {
      return error.message
    }
  }

  deleteMessage(id) {
    this.environment_details.memory_list = this.environment_details.memory_list.filter(memory => memory.id != id);
  }

  deleteMemory(memory_id) {
    this.environment_details.memory_list = this.environment_details.memory_list.filter(memory => memory.memory_id != memory_id);
  }

  constructor(tools = {}) {
    super();
    this.mcp_client = new MCPClient();
    const base_tools = {
      "mcp_server": {
        func: async ({ name, args }) => {
          const params = {
            name: name,
            arguments: args
          }
          const result = await this.mcp_client.client.callTool(params, undefined, {
            timeout: (utils.getConfig("tool_call")?.mcp_timeout || 600) * 1000
          });
          return result;
        }
      },
      "ask_followup_question": {
        func: async ({ question, options }) => {
          this.state = State.PAUSE;
          return { question, options }
        }
      },
      "waiting_feedback": {
        func: () => {
          this.state = State.PAUSE;
          return { question: "Task paused, waiting for user feedback...", options: ["Allow", "Deny"] }
        }
      },
      "plan_mode_response": {
        func: async ({ response, options }) => {
          this.state = State.PAUSE;
          return { question: response, options }
        }
      },
      "terminate": {
        func: ({ final_answer }) => {
          this.state = State.FINAL;
          return final_answer;
        }
      },
      "memory_retrieval": {
        func: ({ memory_id }) => {
          const memory = getMessages().filter(m => m.memory_id === memory_id).map(m => { return { role: m.role, content: m.content } });
          return memory || "No memory ID found";
        }
      },
    }

    this.tool_prompt = []
    for (let key in tools) {
      if (!!tools[key]?.getPrompt) {
        const getPrompt = tools[key].getPrompt;
        this.tool_prompt.push(getPrompt());
      }
    }
    this.tools = { ...tools, ...base_tools }

    this.task_prompt = `You are BixChat, an all-around AI assistant designed to solve any tasks proposed by users. You can use various tools to efficiently complete complex requests.

You should strictly follow the entire process of thinking first, then acting, and then observing:
1. Thinking: Describe your thought process or plan to solve this problem
2. Action: Based on your thinking, determine the tools needed to be called
3. Observation: Analyze the results of the action and incorporate them into your thinking


Tool usage instructions:
You can access and use a series of tools according to the user's approval. Only one tool can be used in each message, and you will receive the execution result of the tool in the user's response. You need to gradually use tools to complete the given task, and each use of the tool should be adjusted based on the results of the previous tool.

====

# Tool usage format:

## Output format:

Tool usage adopts the format of pure JSON content, prohibiting the use of any Markdown code block tags (including \`\`\`json or \`\`\`), and should not contain additional explanations, comments, or non-JSON text. The following is a structural example:

{{
  "thinking": "[Thinking process]",
  "tool": "[Tool name]",
  "params": {{
    "[parameter1_name]": "[value1]",
    "[parameter2_name]": "[value2]",
    ...
  }}
}}

## Example:
{{
  "thinking": "The user simply greets without proposing a specific task or question. In planning mode, I need to communicate with the user to understand their needs or tasks.",
  "tool": "plan_mode_response",
  "params": {{
    "response": "Hello! May I help you with anything?",
    "options": [
      "I need help completing a project",
      "I want to learn how to use certain tools",
      "I have some specific questions that need answers"
    ]
  }}
}}

Please always follow this format to ensure the tool can be correctly parsed and executed.

====

# Tools:

{tool_prompt}

## mcp_server
Description: Request MCP (Model Context Protocol) service.
Parameters:
- name: (Required) The name of the MCP service to request.
- args: (Required) The parameters of the MCP service request.
Usage:
{{
  "thinking": "[Thinking process]",
  "tool": "mcp_server",
  "params": {{
    "name": "[value]",
    "args": {{
      "[parameter1_name]": [value1],
      "[parameter2_name]": [value2],
      ...
    }}
  }}
}}

## ask_followup_question
Description: Ask the user questions to collect additional information needed to complete the task. It should be used when encountering ambiguity, needing clarification, or requiring more details to proceed effectively. It achieves interactive problem-solving by allowing direct communication with the user. Use this tool wisely to balance between collecting necessary information and avoiding excessive back-and-forth communication.
Parameters:
- question: (Required) The question to ask the user. This should be a clear and specific question targeting the information you need.
- options: (Optional) Provide the user with 2-5 options to choose from. Each option should be a string describing a possible answer. You do not always need to provide options, but in many cases, this can help the user avoid manually entering a response.
Usage:
{{
  "thinking": "[Thinking process]",
  "tool": "ask_followup_question",
  "params": {{
    "question": "[value]",
    "options": [
      "Option 1",
      "Option 2",
      ...
    ]
  }}
}}

## waiting_feedback
Description: When file operations or system commands need to be executed, call this task to wait for user approval or rejection.
Usage example:
{{
  "thinking": "[Thinking process]",
  "tool": "waiting_feedback",
  "params": {{}}
}}

## plan_mode_response
Description: Respond to user inquiries to plan solutions for user tasks. This tool should be used when you need to respond to user questions or statements about how to complete a task. This tool is only available in "planning mode". The environment details will specify the current mode; if it is not "planning mode", this tool should not be used. Depending on the user's message, you may ask questions to clarify the user's request, design a solution for the task, and brainstorm with the user. For example, if the user's task is to create a website, you can start by asking some clarifying questions, then propose a detailed plan based on the context, explain how you will complete the task, and possibly engage in back-and-forth discussions until the user switches you to another mode to implement the solution before finalizing the details.
Parameters:
response: (Required) The response provided to the user after the thinking process.
options: (Optional) An array containing 2-5 options for the user to choose from. Each option should describe a possible choice or a forward path in the planning process. This can help guide the discussion and make it easier for the user to provide input on key decisions. You may not always need to provide options, but in many cases, this can save the user time from manually entering a response. Do not provide options to switch modes, as there is no need for you to guide the user's operations.
Usage:
{{
  "thinking": "[Thinking process]",
  "tool": "plan_mode_response",
  "params": {{
    "response": "[value]",
    "options": [
      "Option 1",
      "Option 2",
      ...
    ]
  }}
}}

## memory_retrieval
Description: The memory retrieval tool (memory_retrieval) is designed to:
1. Reload Historical Data: Access complete details of past tool calls including parameters, execution results and contextual information.
2. Troubleshoot Issues: Compare current operations with historical successful records to identify potential errors.
3. Continue Analyses: Seamlessly resume interrupted workflows by restoring exact previous states.
4. Ensure Consistency: Validate multi-step analysis processes by cross-referencing with historical outputs.
5. Context Reconstruction: Rebuild complete conversation context at any recorded point in time.
6. Performance Optimization: Retrieve cached results to avoid redundant computations.

Parameters:
- memory_id: (Required) Unique identifier for a specific historical interaction.
  - Type: Integer
  - Description: Unique identifier for a specific historical interaction
  - Valid values: 
    * Numerical IDs from Memory List
  - Format: Must match existing memory_id in Memory List

Usage:
{
  "thinking": "[Explain purpose of this retrieval and how it will be used in current analysis]",
  "tool": "memory_retrieval",
  "params": {
    "memory_id": "[valid_memory_id]"
  }
}

Example Usage Scenarios:
1. Retrieving parameters from previous successful run:
{
  "thinking": "Need to verify the exact parameters used in xxx successful analysis for consistency",
  "tool": "memory_retrieval",
  "params": {
    "memory_id": 12
  }
}

2. Retrieving the results from previous tool execution:
{
  "thinking": "Since the xxx file was not found, but I noticed that the xxx tool has been successfully executed in the memory of previous conversations, and I can directly retrieve the results of its execution.",
  "tool": "memory_retrieval",
  "params": {
    "memory_id": 24
  }
}

## terminate
Description: Stop the task (called when the task is judged to be completed)
Parameters:
- final_answer: (Required) Summarize and give the final answer (MarkDown format)
Usage:
{{
  "thinking": "[Thinking process]",
  "tool": "terminate",
  "params": {{
    "final_answer": "[value]"
  }}
}}

====

# Available MCP Services

{mcp_prompt}

====

{extra_prompt}

====

# Automatic Mode vs. Execution Mode vs. Planning Mode

Environment details will specify the current mode, there are three modes: 

**Automatic Mode**: In this mode, you cannot use plan_mode_response, waiting_feedback and ask_followup_question tools.

- In automatic mode, you can use tools other than plan_mode_response, waiting_feedback and ask_followup_question to complete the user's task, and the subsequent process does not need to ask the user questions until the mode changes.
- When your environment changes from other modes to automatic mode, you should be aware that you do not need to ask the user questions in the subsequent process until the mode changes.
- Once the task is completed, you use the terminate tool to show the task result to the user.

**Execution Mode**: In this mode, you cannot use the plan_mode_response tool.

- In execution mode, you can use tools other than plan_mode_response to complete the user's task.
- Once the task is completed, you use the terminate tool to show the task result to the user.

**Planning Mode**: In this special mode, you can only use the plan_mode_response tool.

- In planning mode, the goal is to collect information and obtain context to create a detailed plan to complete the user's task. The user will review and approve the plan, then switch to execution mode or automatic mode to implement the solution.
- In planning mode, when you need to communicate with the user or present a plan, you should directly use the plan_mode_response tool to deliver your response.
- If the current mode switches to planning mode, you should stop any pending tasks and discuss with the user to plan how best to proceed with the task.
- In planning mode, depending on the user's request, you may need to do some information gathering, such as asking the user clarifying questions to better understand the task.
- Once you have more context about the user's request, you should develop a detailed plan to complete the task.
- Then, you can ask the user if they are satisfied with the plan or if they wish to make any changes. Consider this a brainstorming session where you can discuss the task and plan the best way to complete it.
- Finally, once you think a good plan has been developed, ask to switch the current mode back to execution mode to implement the solution.

====

# Goals

You complete the given task iteratively, breaking it down into clear steps and systematically completing these steps.

1. Analyze the user's task and set clear, achievable goals to complete the task. Prioritize these goals in a logical order.
2. Complete these goals in order, using the available tools one by one if necessary. Each goal should correspond to a clear step in your problem-solving process. You will understand the work done and the remaining work in the process.
3. Remember that you have extensive capabilities and can access various tools that can be used in powerful and clever ways as needed. Before calling a tool, analyze it within the [thinking process]. First, analyze the current mode provided in the "Environment Details" to select the scope of tool usage.
4. Next, when you are in "execution mode", check each required parameter of the relevant tools one by one and determine whether the user has directly provided enough information to infer the value. When deciding whether a parameter can be inferred, carefully consider all the context to see if it supports a specific value. If all required parameters exist or can be reasonably inferred, proceed with using the tool. However, if a required parameter value is missing, do not call the tool (even if you use a placeholder to fill in the missing parameter), but use the ask_followup_question tool to ask the user to provide the missing parameter. If information about optional parameters is not provided, do not ask for more information.
5. When you are in "automatic mode", you should also check each required parameter of the relevant tools one by one. If a required parameter value is missing, automatically plan a solution and execute it. Remember that in this mode, it is strictly forbidden to call tools that interact with the user.
6. Once the user's task is completed, you must use the terminate tool to show the task result to the user.
7. You should determine whether reloading the tool execution result is necessary based on the context information.

====

# Environment Details Explanation
- Language: The type of language the assistant needs to use to reply to messages
- Temporary folder: The location where temporary files are stored during the execution process
- Current time: Current system time
- Current mode: The current mode (automatic mode / execution mode / planning mode)

====

# System Information

- Operating system type: {system_type}
- Operating system platform: {system_platform}
- CPU architecture: {system_arch}

===

# Memory List Explanation

## Basic Concepts
1. **What is Memory List**
   - Each user-assistant interaction generates a unique \`memory_id\`
   - These \`memory_id\`s are sequentially arranged to form complete interaction history
   - Essentially our "conversation memory bank"

2. **Function of memory_retrieval tool**
   - Specialized query tool for viewing detailed historical interaction information
   - Can be understood as a "conversation recall" function

## Usage Scenarios (When to call)
1. **Backtracking analysis**: When needing to reference previous analysis steps
2. **Content verification**: When user questions involve historically discussed content
3. **Detail confirmation**: When needing to understand specific parameters/results of historical tool calls
4. **Repeat operations**: Before executing the same tool again, first check previous execution results

## Important Notes
- Memory capacity: System saves complete interaction history but with storage limits
- Query method: Can only be accessed via memory_retrieval tool
- Automatic recording: All user queries and tool calls are automatically saved

## Usage Recommendation
**For users**:
When needing to reference previous content in conversation, you can say: "Please check our previous discussion about XX", and I'll use memory_retrieval tool.

**For AI autonomous calls**:
I will automatically invoke memory_retrieval when:
1. Detecting repeated questions or similar requests
2. Needing to maintain conversation continuity
3. Required to verify historical tool execution parameters
4. Asked to summarize or continue previous work
5. Encountering ambiguous references that need context clarification

Example autonomous call situations:
- "Let me check our previous analysis steps..."
- "I'll verify the parameters used last time..."
- "Based on our earlier discussion about XX..."

====

# Memory List:
{memory_list}

====`

    this.system_prompt;
    this.mcp_prompt;
    this.memory_id = 0;

    this.env = `Environment details:
- Language: {language}
- Temporary folder: {tmpdir}
- Current time: {time}
- Current mode: {mode}`

    this.modes = {
      AUTO: 'Automatic mode',
      ACT: 'Execution mode',
      PLAN: 'Planning mode',
    }

    this.environment_details = {
      memory_list: [],
      language: utils.getLanguage(),
      tmpdir: utils.getConfig("tool_call")?.tmpdir || os.tmpdir(),
      time: utils.formatDate(),
      mode: this.modes.ACT,
    }
  }

  clear_memory() {
    this.environment_details.memory_list.length = 0
  }

  get_extra_prompt(file) {
    try {
      const prompt_path = file?.format(process);
      if (!fs.existsSync(prompt_path)) {
        return fs.readFileSync(path.join(__dirname, '../extra_prompt.md'), 'utf-8');
      }
      return fs.readFileSync(file.format(process), 'utf-8');
    } catch (error) {
      console.log(error.message);
      return "";
    }
  }

  environment_update(data) {
    this.environment_details.time = utils.formatDate();
    this.environment_details.language = data?.language || utils.getLanguage();
    let messages = getMessages()
    let messages_list = messages.slice(messages.length - data.long_memory_length - data.memory_length, messages.length - data.memory_length).map(message => {
      let message_copy = utils.copy(message)
      const content_json = utils.extractJson(message_copy.content);
      if (!!content_json) {
        const tool_info = JSON5.parse(content_json);
        if (tool_info?.observation && message_copy.role == "user") {
          message_copy.content = `Assistant called ${tool_info.tool_call} tool`;
        }
      }
      delete message_copy.react;
      delete message_copy.id;
      delete message_copy.show;
      return message_copy;

    })
    this.environment_details.memory_list = messages_list
    data.env_message = envMessage(this.env.format(this.environment_details));
  }

  plan_act_mode(mode) {
    this.environment_details.mode = mode;
  }

  async step(data) {
    if (!this.mcp_prompt) {
      this.mcp_prompt = await this.init_mcp();
    }
    data.push_message = false
    if (this.state == State.IDLE) {
      pushMessage("user", data.query, data.id, ++this.memory_id, true, false);
      this.environment_update(data);
      this.state = State.RUNNING;
    }
    this.system_prompt = this.task_prompt.format({
      system_type: utils.getConfig("tool_call")?.system_type || os.type(),
      system_platform: utils.getConfig("tool_call")?.system_platform || os.platform(),
      system_arch: utils.getConfig("tool_call")?.system_arch || os.arch(),
      tool_prompt: this.tool_prompt.join("\n\n"),
      mcp_prompt: this.mcp_prompt,
      extra_prompt: this.get_extra_prompt(data.extra_prompt),
      memory_list: JSON.stringify(this.environment_details.memory_list, null, 2)
    })
    const tool_info = await this.task(data);
    // Check if a tool needs to be called
    if (tool_info?.tool) {
      const { observation, output } = await this.act(tool_info);
      data.output_format = observation;
      pushMessage("user", data.output_format, data.id, this.memory_id);
      this.environment_update(data);
      if (tool_info.tool == "display_file") {
        data.event.sender.send('stream-data', { id: data.id, memory_id:this.memory_id, content: `${output}\n\n` });
      }
      if (this.state == State.PAUSE) {
        const { question, options } = output;
        data.event.sender.send('stream-data', { id: data.id, memory_id:this.memory_id, content: question, end: true });
        return options;
      }
      if (this.state == State.FINAL) {
        data.event.sender.send('stream-data', { id: data.id, memory_id:this.memory_id, content: output, end: true });
      } else {
        data.event.sender.send('info-data', { id: data.id, memory_id:this.memory_id, content: this.get_info(data) });
      }
    }
  }

  async task(data) {
    data.prompt = this.system_prompt;
    const raw_json = await this.llmCall(data);
    console.log(`raw_json: ${raw_json}`);
    data.output_format = utils.extractJson(raw_json) || raw_json;
    data.event.sender.send('info-data', { id: data.id, memory_id:this.memory_id, content: this.get_info(data) });
    return this.get_tool(data.output_format, data);
  }

  async act({ tool, params }) {
    try {
      if (!this.tools.hasOwnProperty(tool)) {
        const observation = `{
  "tool_call": "${tool}",
  "observation": "Tool does not exist",
  "error": "Please check if the tool name is incorrect or if the MCP service call format is wrong"
}`;
        setTag(false);
        return { observation, output: null };
      }
      const will_tool = this.tools[tool].func;
      const output = await will_tool(params);
      const observation = `{
  "tool_call": "${tool}",
  "observation": ${JSON.stringify(output, null, 2)},
  "error": ""
}`;
      if (tool == "cli_execute") {
        const success = output?.success;
        setTag(success);
      } else {
        setTag(true);
      }
      return { observation, output };
    } catch (error) {
      console.log(error);
      const observation = `{
  "tool_call": "${tool}",
  "observation": "Tool has been executed",
  "error": "${error.message}"
}`;
      setTag(false);
      return { observation, output: error.message };
    }
  }

  get_tool(content, data) {
    pushMessage("assistant", content, data.id, ++this.memory_id);
    try {
      const tool_info = JSON5.parse(content);
      if (!!tool_info?.thinking) {
        data.event.sender.send('stream-data', { id: data.id, memory_id:this.memory_id, content: `${tool_info.thinking}\n\n---\n\n` });
      }
      if (!!tool_info?.tool) {
        return tool_info;
      }
    } catch (error) {
      console.log(error);
      data.output_format = `{
  "tool_call": "${tool}",
  "observation": "Tool was not executed",
  "error": "Your response is not a pure JSON text, or there is a problem with the JSON format: ${error.message}"
}`;
      setTag(false);
      pushMessage("user", data.output_format, data.id, this.memory_id);
      this.environment_update(data);
      data.event.sender.send('info-data', { id: data.id, memory_id:this.memory_id, content: this.get_info(data) });
    }
  }

  load_message(window, filePath) {
    this.window = window;

    clearMessages();
    this.clear_memory();
    this.window.webContents.send('clear')
    let messages = loadMessages(filePath)
    if (messages.length > 0) {
      const maxId = messages.reduce((max, current) => {
        return parseInt(current.id) > parseInt(max.id) ? current : max;
      }, messages[0]);
      if (!!maxId.id) {
        global.id = parseInt(maxId.id);
        const react = messages.find(message => message.react);
        if (!!react) {
          const maxMemoryId = messages.reduce((max, current) => {
            return parseInt(current.memory_id) > parseInt(max.memory_id) ? current : max;
          }, messages[0]);
          this.memory_id = maxMemoryId.memory_id;
        }
        for (let i in messages) {
          i = parseInt(i);
          if (Object.hasOwnProperty.call(messages, i)) {
            let { role, content, id, memory_id, react } = messages[i];
            if (role == "user") {
              if (!!react) {
                const content_json = utils.extractJson(content);
                if (!!content_json) {
                  const tool_info = JSON5.parse(content_json);
                  const tool = tool_info?.tool_call;
                  if (tool == "display_file") {
                    const observation = tool_info.observation;
                    this.window.webContents.send('stream-data', { id: id, memory_id:memory_id, content: `${observation}\n\n`, end: true });
                  }
                }
                let content_format = content.replaceAll("\`", "'").replaceAll("`", "'");
                this.window.webContents.send('info-data', { id: id, memory_id:memory_id, content: `Step ${i}, Output: \n\n\`\`\`json\n${content_format}\n\`\`\`\n\n` });
              }
              else {
                this.window.webContents.send('user-data', { id: id, memory_id:memory_id, content: content });
              }
            } else {
              if (!!react) {
                try {
                  content = utils.extractJson(content) || content;
                  const tool_info = JSON5.parse(content);
                  if (!!tool_info?.thinking) {
                    const thinking = `${tool_info.thinking}\n\n---\n\n`
                    let content_format = content.replaceAll("\`", "'").replaceAll("`", "'");
                    this.window.webContents.send('info-data', { id: id, memory_id:memory_id, content: `Step ${i}, Output:\n\n\`\`\`json\n${content_format}\n\`\`\`\n\n` });
                    this.window.webContents.send('stream-data', { id: id, memory_id:memory_id, content: thinking, end: true });
                    if (tool_info.tool == "terminate") {
                      this.window.webContents.send('stream-data', { id: id, memory_id:memory_id, content: tool_info.params.final_answer, end: true });
                    }
                  }
                } catch (error) {
                  continue;
                }
              } else {
                this.window.webContents.send('stream-data', { id: id, content: content, end: true });
              }
            }
          }
        }
        console.log(`Load success: ${filePath}`)
      } else {
        console.log(`Load failed: ${filePath}`)
      }
    };
  }
}

module.exports = {
  ToolCall
};
