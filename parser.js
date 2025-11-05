// parser.js

/**
 * @typedef {Object} ShaderParameter
 * @property {string} name - The variable name in the shader code.
 * @property {string} type - The data type (e.g., 'float', 'vec2').
 * @property {string} label - The UI label for this parameter.
 * @property {number} default - The default value.
 * @property {number} [min] - The minimum allowed value.
 * @property {number} [max] - The maximum allowed value.
 * @property {number} [step] - The slider step value.
 */

/**
 * @typedef {Object} ShaderResource
 * @property {string} name - The name of the texture or sampler.
 * @property {string} type - The resource type (e.g., 'Texture2D').
 * @property {Object.<string, string>} metadata - Other metadata like WIDTH, HEIGHT, FILTER.
 */

/**
 * @typedef {Object} ShaderPass
 * @property {number} id - The pass number.
 * @property {string[]} inputs - A list of resource names used as input.
 * @property {string[]} outputs - A list of resource names used as output.
 * @property {Object.<string, string>} metadata - Other metadata like BLOCK_SIZE.
 */

/**
 * @typedef {Object} ShaderInfo
 * @property {Object.<string, string>} metadata - General metadata (EFFECT, VERSION).
 * @property {ShaderParameter[]} parameters - A list of uniform parameters.
 * @property {ShaderResource[]} textures - A list of texture resources.
 * @property {ShaderResource[]} samplers - A list of sampler resources.
 * @property {ShaderPass[]} passes - A list of rendering passes.
 * @property {string} codeBody - The raw shader code after the header.
 */

// Regex patterns for parsing
const Patterns = {
    // Matches primary directives like "//!PARAMETER" or "//!PASS 1"
    MAIN_DIRECTIVE: /^\s*\/\/!\s*([A-Z]+)(?:\s+(.*))?/,
    // Matches metadata like "//!LABEL Strength"
    METADATA: /^\s*\/\/!\s*([A-Z]+)\s+(.*)/,
    // Matches variable declarations like "float intensitySigma;"
    VARIABLE_DECL: /^\s*(\w+)\s+(\w+);/,
};

export class ShaderParser {
    /**
     * Parses a shader string with custom Magpie headers.
     * @param {string} shaderCode The full shader code.
     * @returns {ShaderInfo} A structured object representing the shader.
     */
    parse(shaderCode) {
        const lines = shaderCode.split('\n');
        const info = this._createEmptyShaderInfo();

        let currentState = null; // Tracks the current block (e.g., { type: 'PARAMETER', data: {} })

        for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine === '') continue; // Skip empty lines

            // It's a directive line
            if (trimmedLine.startsWith('//')) {
                const mainDirectiveMatch = trimmedLine.match(Patterns.MAIN_DIRECTIVE);

                // Check if it's a MAIN directive (PARAMETER, TEXTURE, PASS, etc.)
                if (mainDirectiveMatch && ['PARAMETER', 'TEXTURE', 'SAMPLER', 'PASS'].includes(mainDirectiveMatch[1])) {
                    this._commitState(currentState, info); // Commit the previous block before starting a new one
                    currentState = this._createState(mainDirectiveMatch);
                }
                // Otherwise, it's metadata for the current block
                else if (currentState) {
                    const metadataMatch = trimmedLine.match(Patterns.METADATA);
                    if (metadataMatch) {
                        const [, key, value] = metadataMatch;
                        currentState.data[key.toLowerCase()] = this._autoParseValue(value);
                    }
                }
                // Or it's global metadata
                else {
                    const metadataMatch = trimmedLine.match(Patterns.METADATA);
                    if (metadataMatch) {
                        const [, key, value] = metadataMatch;
                        info.metadata[key.toLowerCase()] = value;
                    }
                }

            }
            // It's a declaration line (float name;)
            else if (currentState) {
                const declMatch = trimmedLine.match(Patterns.VARIABLE_DECL);
                if (declMatch) {
                    const [, type, name] = declMatch;
                    currentState.data.type = type;
                    currentState.data.name = name;
                    this._commitState(currentState, info);
                    currentState = null; // This block is complete
                } else {
                    // This could be an error or start of the code body
                    this._commitState(currentState, info);
                    currentState = null;
                    // We assume headers are finished if a non-empty, non-comment, non-declaration line is found
                    break;
                }
            } else {
                // First line of code body encountered
                break;
            }
        }

        // Commit any lingering state at the end of the file
        this._commitState(currentState, info);

        // Simple way to find the code body: find the first non-header line
        const headerEndIndex = shaderCode.lastIndexOf(lines.find(l => !l.trim().startsWith('//!') && l.trim() !== ''))
        info.codeBody = headerEndIndex !== -1 ? shaderCode.substring(headerEndIndex) : '';

        return info;
    }

    _createEmptyShaderInfo() {
        return {
            metadata: {},
            parameters: [],
            textures: [],
            samplers: [],
            passes: [],
            codeBody: ''
        };
    }

    _createState(match) {
        const [, type, value] = match;
        const state = { type, data: {} };
        if (type === 'PASS') {
            state.data.id = parseInt(value, 10);
            state.data.inputs = [];
            state.data.outputs = [];
        }
        return state;
    }

    _commitState(state, info) {
        if (!state) return;

        // Special handling for PASS inputs/outputs
        if (state.type === 'PASS') {
            if (state.data.in) state.data.inputs.push(state.data.in);
            if (state.data.out) state.data.outputs.push(state.data.out);
            delete state.data.in; // cleanup
            delete state.data.out; // cleanup
        }

        switch (state.type) {
            case 'PARAMETER':
                if (state.data.name) info.parameters.push(state.data);
                break;
            case 'TEXTURE':
                if (state.data.name) info.textures.push(state.data);
                break;
            case 'SAMPLER':
                if (state.data.name) info.samplers.push(state.data);
                break;
            case 'PASS':
                if (state.data.id) info.passes.push(state.data);
                break;
        }
    }

    _autoParseValue(value) {
        if (!isNaN(value) && value.trim() !== '') {
            return parseFloat(value);
        }
        return value;
    }
}