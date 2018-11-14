import { parseExpressionAt } from 'acorn';
import MagicString, { Bundle } from 'magic-string';
import isReference from 'is-reference';
import { walk, childKeys } from 'estree-walker';
import { getLocator } from 'locate-character';
import Stats from '../Stats';
import deindent from '../utils/deindent';
import reservedNames from '../utils/reservedNames';
import namespaces from '../utils/namespaces';
import { removeNode } from '../utils/removeNode';
import nodeToString from '../utils/nodeToString';
import wrapModule from './wrapModule';
import { createScopes } from '../utils/annotateWithScopes';
import getName from '../utils/getName';
import Stylesheet from './css/Stylesheet';
import { test } from '../config';
import Fragment from './nodes/Fragment';
import shared from './shared';
import { Node, ShorthandImport, Ast, CompileOptions, CustomElementOptions } from '../interfaces';
import error from '../utils/error';
import getCodeFrame from '../utils/getCodeFrame';
import checkForComputedKeys from './validate/js/utils/checkForComputedKeys';
import checkForDupes from './validate/js/utils/checkForDupes';
import propValidators from './validate/js/propValidators';
import fuzzymatch from './validate/utils/fuzzymatch';
import flattenReference from '../utils/flattenReference';

interface Computation {
	key: string;
	deps: string[];
	hasRestParam: boolean;
}

interface Declaration {
	type: string;
	name: string;
	node: Node;
	block: string;
}

function detectIndentation(str: string) {
	const pattern = /^[\t\s]{1,4}/gm;
	let match;

	while (match = pattern.exec(str)) {
		if (match[0][0] === '\t') return '\t';
		if (match[0].length === 2) return '  ';
	}

	return '    ';
}

function getIndentationLevel(str: string, b: number) {
	let a = b;
	while (a > 0 && str[a - 1] !== '\n') a -= 1;
	return /^\s*/.exec(str.slice(a, b))[0];
}

function getIndentExclusionRanges(node: Node) {
	// TODO can we fold this into a different pass?
	const ranges: Node[] = [];
	walk(node, {
		enter(node: Node) {
			if (node.type === 'TemplateElement') ranges.push(node);
		}
	});
	return ranges;
}

function increaseIndentation(
	code: MagicString,
	start: number,
	end: number,
	indentationLevel: string,
	ranges: Node[]
) {
	const str = code.original.slice(start, end);
	const lines = str.split('\n');

	let c = start;
	lines.forEach(line => {
		if (line) {
			code.prependRight(c, '\t\t\t'); // TODO detect indentation
		}

		c += line.length + 1;
	});
}

// We need to tell estree-walker that it should always
// look for an `else` block, otherwise it might get
// the wrong idea about the shape of each/if blocks
childKeys.EachBlock = childKeys.IfBlock = ['children', 'else'];
childKeys.Attribute = ['value'];

export default class Component {
	stats: Stats;

	ast: Ast;
	source: string;
	name: string;
	options: CompileOptions;
	fragment: Fragment;

	customElement: CustomElementOptions;
	tag: string;
	props: string[];

	properties: Map<string, Node>;

	defaultExport: Node;
	imports: Node[];
	shorthandImports: ShorthandImport[];
	helpers: Set<string>;
	components: Set<string>;
	events: Set<string>;
	methods: Set<string>;
	animations: Set<string>;
	transitions: Set<string>;
	actions: Set<string>;
	importedComponents: Map<string, string>;
	namespace: string;
	hasComponents: boolean;
	computations: Computation[];
	templateProperties: Record<string, Node>;
	javascript: [string, string];

	used: {
		components: Set<string>;
		helpers: Set<string>;
		events: Set<string>;
		animations: Set<string>;
		transitions: Set<string>;
		actions: Set<string>;
	};

	declarations: string[];

	refCallees: Node[];

	code: MagicString;

	indirectDependencies: Map<string, Set<string>>;
	expectedProperties: Set<string>;
	refs: Set<string>;

	file: string;
	locate: (c: number) => { line: number, column: number };

	stylesheet: Stylesheet;

	userVars: Set<string>;
	templateVars: Map<string, string>;
	aliases: Map<string, string>;
	usedNames: Set<string>;

	locator: (search: number, startIndex?: number) => {
		line: number,
		column: number
	};

	constructor(
		ast: Ast,
		source: string,
		name: string,
		options: CompileOptions,
		stats: Stats
	) {
		this.stats = stats;

		this.ast = ast;
		this.source = source;
		this.options = options;

		this.imports = [];
		this.shorthandImports = [];
		this.helpers = new Set();
		this.components = new Set();
		this.events = new Set();
		this.methods = new Set();
		this.animations = new Set();
		this.transitions = new Set();
		this.actions = new Set();
		this.importedComponents = new Map();

		this.used = {
			components: new Set(),
			helpers: new Set(),
			events: new Set(),
			animations: new Set(),
			transitions: new Set(),
			actions: new Set(),
		};

		this.declarations = [];

		this.refs = new Set();
		this.refCallees = [];

		this.indirectDependencies = new Map();

		this.file = options.filename && (
			typeof process !== 'undefined' ? options.filename.replace(process.cwd(), '').replace(/^[\/\\]/, '') : options.filename
		);
		this.locate = getLocator(this.source);

		// track which properties are needed, so we can provide useful info
		// in dev mode
		this.expectedProperties = new Set();

		this.code = new MagicString(source);

		// styles
		this.stylesheet = new Stylesheet(source, ast, options.filename, options.dev);
		this.stylesheet.validate(this);

		// allow compiler to deconflict user's `import { get } from 'whatever'` and
		// Svelte's builtin `import { get, ... } from 'svelte/shared.ts'`;
		this.userVars = new Set();
		this.templateVars = new Map();
		this.aliases = new Map();
		this.usedNames = new Set();

		this.computations = [];
		this.templateProperties = {};
		this.properties = new Map();

		this.walkJs();
		this.name = this.alias(name);

		if (options.customElement === true) {
			this.customElement = {
				tag: null,
				props: [] // TODO!!!
			};

			// find <svelte:meta> tag
			const meta = this.ast.html.children.find(node => node.name === 'svelte:meta');
			if (meta) {
				const tag_attribute = meta.attributes.find(a => a.name === 'tag');
				if (tag_attribute) {
					this.customElement.tag = tag_attribute.value[0].data;
				}
			}
		} else {
			this.customElement = options.customElement;
		}

		if (this.customElement && !this.customElement.tag) {
			throw new Error(`No tag name specified`); // TODO better error
		}

		this.fragment = new Fragment(this, ast.html);
		// this.walkTemplate();
		if (!this.customElement) this.stylesheet.reify();

		this.stylesheet.warnOnUnusedSelectors(options.onwarn);

		if (this.defaultExport) {
			const categories = {
				components: 'component',
				helpers: 'helper',
				events: 'event definition',
				transitions: 'transition',
				actions: 'actions',
			};

			Object.keys(categories).forEach(category => {
				const definitions = this.defaultExport.declaration.properties.find(prop => prop.key.name === category);
				if (definitions) {
					definitions.value.properties.forEach(prop => {
						const { name } = prop.key;
						if (!this.used[category].has(name)) {
							this.warn(prop, {
								code: `unused-${category.slice(0, -1)}`,
								message: `The '${name}' ${categories[category]} is unused`
							});
						}
					});
				}
			});
		}

		this.refCallees.forEach(callee => {
			const { parts } = flattenReference(callee);
			const ref = parts[1];

			if (this.refs.has(ref)) {
				// TODO check method is valid, e.g. `audio.stop()` should be `audio.pause()`
			} else {
				const match = fuzzymatch(ref, Array.from(this.refs.keys()));

				let message = `'refs.${ref}' does not exist`;
				if (match) message += ` (did you mean 'refs.${match}'?)`;

				this.error(callee, {
					code: `missing-ref`,
					message
				});
			}
		});
	}

	addSourcemapLocations(node: Node) {
		walk(node, {
			enter: (node: Node) => {
				this.code.addSourcemapLocation(node.start);
				this.code.addSourcemapLocation(node.end);
			},
		});
	}

	alias(name: string) {
		if (!this.aliases.has(name)) {
			this.aliases.set(name, this.getUniqueName(name));
		}

		return this.aliases.get(name);
	}

	generate(result: string, options: CompileOptions, {
		banner = '',
		name,
		format
	}) {
		const pattern = /\[✂(\d+)-(\d+)$/;

		const helpers = new Set();

		// TODO use same regex for both
		result = result.replace(options.generate === 'ssr' ? /(@+|#+|%+)(\w*(?:-\w*)?)/g : /(%+|@+)(\w*(?:-\w*)?)/g, (match: string, sigil: string, name: string) => {
			if (sigil === '@') {
				if (name in shared) {
					if (options.dev && `${name}Dev` in shared) name = `${name}Dev`;
					helpers.add(name);
				}

				return this.alias(name);
			}

			if (sigil === '%') {
				return this.templateVars.get(name);
			}

			return sigil.slice(1) + name;
		});

		const importedHelpers = Array.from(helpers).concat('SvelteComponent').sort().map(name => {
			const alias = this.alias(name);
			return { name, alias };
		});

		const sharedPath = options.shared || 'svelte/internal.js';

		const module = wrapModule(result, format, name, options, banner, sharedPath, importedHelpers, this.imports, this.shorthandImports, this.source);

		const parts = module.split('✂]');
		const finalChunk = parts.pop();

		const compiled = new Bundle({ separator: '' });

		function addString(str: string) {
			compiled.addSource({
				content: new MagicString(str),
			});
		}

		const { filename } = options;

		// special case — the source file doesn't actually get used anywhere. we need
		// to add an empty file to populate map.sources and map.sourcesContent
		if (!parts.length) {
			compiled.addSource({
				filename,
				content: new MagicString(this.source).remove(0, this.source.length),
			});
		}

		parts.forEach((str: string) => {
			const chunk = str.replace(pattern, '');
			if (chunk) addString(chunk);

			const match = pattern.exec(str);

			const snippet = this.code.snip(+match[1], +match[2]);

			compiled.addSource({
				filename,
				content: snippet,
			});
		});

		addString(finalChunk);

		const css = this.customElement ?
			{ code: null, map: null } :
			this.stylesheet.render(options.cssOutputFilename, true);

		const js = {
			code: compiled.toString(),
			map: compiled.generateMap({
				includeContent: true,
				file: options.outputFilename,
			})
		};

		return {
			ast: this.ast,
			js,
			css,
			stats: this.stats.render(this)
		};
	}

	getUniqueName(name: string) {
		if (test) name = `${name}$`;
		let alias = name;
		for (
			let i = 1;
			reservedNames.has(alias) ||
			this.userVars.has(alias) ||
			this.usedNames.has(alias);
			alias = `${name}_${i++}`
		);
		this.usedNames.add(alias);
		return alias;
	}

	getUniqueNameMaker() {
		const localUsedNames = new Set();

		function add(name: string) {
			localUsedNames.add(name);
		}

		reservedNames.forEach(add);
		this.userVars.forEach(add);

		return (name: string) => {
			if (test) name = `${name}$`;
			let alias = name;
			for (
				let i = 1;
				this.usedNames.has(alias) ||
				localUsedNames.has(alias);
				alias = `${name}_${i++}`
			);
			localUsedNames.add(alias);
			return alias;
		};
	}

	error(
		pos: {
			start: number,
			end: number
		},
		e : {
			code: string,
			message: string
		}
	) {
		error(e.message, {
			name: 'ValidationError',
			code: e.code,
			source: this.source,
			start: pos.start,
			end: pos.end,
			filename: this.options.filename
		});
	}

	warn(
		pos: {
			start: number,
			end: number
		},
		warning: {
			code: string,
			message: string
		}
	) {
		if (!this.locator) {
			this.locator = getLocator(this.source, { offsetLine: 1 });
		}

		const start = this.locator(pos.start);
		const end = this.locator(pos.end);

		const frame = getCodeFrame(this.source, start.line - 1, start.column);

		this.stats.warn({
			code: warning.code,
			message: warning.message,
			frame,
			start,
			end,
			pos: pos.start,
			filename: this.options.filename,
			toString: () => `${warning.message} (${start.line + 1}:${start.column})\n${frame}`,
		});
	}

	walkJs() {
		const { js } = this.ast;
		if (!js) return;

		this.addSourcemapLocations(js.content);

		const { code, source, imports } = this;

		const indentationLevel = getIndentationLevel(source, js.content.body[0].start);
		const indentExclusionRanges = getIndentExclusionRanges(js.content);

		const { scope, globals } = createScopes(js.content);

		scope.declarations.forEach(name => {
			this.userVars.add(name);
			this.declarations.push(name);
		});

		globals.forEach(name => {
			this.userVars.add(name);
		});

		const body = js.content.body.slice(); // slice, because we're going to be mutating the original

		body.forEach(node => {
			if (node.type === 'ExportDefaultDeclaration') {
				this.error(node, {
					code: `default-export`,
					message: `A component cannot have a default export`
				})
			}

			// imports need to be hoisted out of the IIFE
			// TODO hoist other stuff where possible
			else if (node.type === 'ImportDeclaration') {
				removeNode(code, js.content, node);
				imports.push(node);

				node.specifiers.forEach((specifier: Node) => {
					this.userVars.add(specifier.local.name);
				});
			}
		});

		let a = js.content.start;
		while (/\s/.test(source[a])) a += 1;

		let b = js.content.end;
		while (/\s/.test(source[b - 1])) b -= 1;

		this.javascript = this.defaultExport
			? [
				a !== this.defaultExport.start ? `[✂${a}-${this.defaultExport.start}✂]` : '',
				b !== this.defaultExport.end ?`[✂${this.defaultExport.end}-${b}✂]` : ''
			]
			: [
				a !== b ? `[✂${a}-${b}✂]` : '',
				''
			];
	}
}
