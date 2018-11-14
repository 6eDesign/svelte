import deindent from '../../utils/deindent';
import { stringify, escape } from '../../utils/stringify';
import CodeBuilder from '../../utils/CodeBuilder';
import globalWhitelist from '../../utils/globalWhitelist';
import Component from '../Component';
import Renderer from './Renderer';
import { CompileOptions } from '../../interfaces';

export default function dom(
	component: Component,
	options: CompileOptions
) {
	const format = options.format || 'es';

	const {
		computations,
		name,
		templateProperties
	} = component;

	const renderer = new Renderer(component, options);

	const { block } = renderer;

	if (component.options.nestedTransitions) {
		block.hasOutroMethod = true;
	}

	// prevent fragment being created twice (#1063)
	if (options.customElement) block.builders.create.addLine(`this.c = @noop;`);

	const builder = new CodeBuilder();

	if (component.options.dev) {
		builder.addLine(`const ${renderer.fileVar} = ${JSON.stringify(component.file)};`);
	}

	const css = component.stylesheet.render(options.filename, !component.customElement);
	const styles = component.stylesheet.hasStyles && stringify(options.dev ?
		`${css.code}\n/*# sourceMappingURL=${css.map.toUrl()} */` :
		css.code, { onlyEscapeAtSymbol: true });

	if (styles && component.options.css !== false && !component.customElement) {
		builder.addBlock(deindent`
			function @add_css() {
				var style = @createElement("style");
				style.id = '${component.stylesheet.id}-style';
				style.textContent = ${styles};
				@append(document.head, style);
			}
		`);
	}

	// fix order
	// TODO the deconflicted names of blocks are reversed... should set them here
	const blocks = renderer.blocks.slice().reverse();

	blocks.forEach(block => {
		builder.addBlock(block.toString());
	});

	const debugName = `<${component.customElement ? component.tag : name}>`;

	const expectedProperties = Array.from(component.expectedProperties);
	const globals = expectedProperties.filter(prop => globalWhitelist.has(prop));

	if (component.customElement) {
		const props = component.props || Array.from(component.expectedProperties);

		builder.addBlock(deindent`
			class ${name} extends HTMLElement {
				constructor(options = {}) {
					super();
				}

				static get observedAttributes() {
					return ${JSON.stringify(props)};
				}

				${props.map(prop => deindent`
					get ${prop}() {
						return this.get().${prop};
					}

					set ${prop}(value) {
						this.set({ ${prop}: value });
					}
				`).join('\n\n')}

				${renderer.slots.size && deindent`
					connectedCallback() {
						Object.keys(this._slotted).forEach(key => {
							this.appendChild(this._slotted[key]);
						});
					}`}

				attributeChangedCallback(attr, oldValue, newValue) {
					this.set({ [attr]: newValue });
				}

				${(component.hasComponents || renderer.hasComplexBindings || templateProperties.oncreate || renderer.hasIntroTransitions) && deindent`
					connectedCallback() {
						@flush(this);
					}
				`}
			}

			customElements.define("${component.tag}", ${name});
		`);
	} else {
		builder.addBlock(deindent`
			class ${name} extends @SvelteComponent {
				__init() {
					${component.javascript}

					return () => ({ ${(component.declarations).join(', ')} });
				}

				__create_fragment(ctx) {
					${block.getContents()}
				}
			}
		`);
	}

	const immutable = templateProperties.immutable ? templateProperties.immutable.value.value : options.immutable;

	let result = builder.toString();

	return component.generate(result, options, {
		banner: `/* ${component.file ? `${component.file} ` : ``}generated by Svelte v${"__VERSION__"} */`,
		name,
		format,
	});
}
