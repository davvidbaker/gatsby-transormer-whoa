/** 💁 The reason I can't just use gatsby-transformer-remark with my own plugin is that I want to return the AST s(o I can use custom React components), not stringified html. */

const {
  GraphQLObjectType,
  GraphQLList,
  GraphQLString,
  GraphQLInt,
  GraphQLEnumType
} = require(`graphql`);
const Remark = require(`remark`);
const select = require(`unist-util-select`);
const sanitizeHTML = require(`sanitize-html`);
const _ = require(`lodash`);
const visit = require(`unist-util-visit`);
const toHAST = require(`mdast-util-to-hast`);
const hastToHTML = require(`hast-util-to-html`);
const mdastToToc = require(`mdast-util-toc`);
const Promise = require(`bluebird`);
const prune = require(`underscore.string/prune`);
const unified = require(`unified`);
const parse = require(`remark-parse`);
const whoa = require(`remark-whoa`);
const stringify = require(`remark-stringify`);
const english = require(`retext-english`);
const remark2retext = require(`remark-retext`);
const frontmatter = require('front-matter');

let pluginsCacheStr = ``;
const astCacheKey = node => `transformer-remark-markdown-ast-${node.internal.contentDigest}-${pluginsCacheStr}`;
const htmlCacheKey = node => `transformer-remark-markdown-html-${node.internal.contentDigest}-${pluginsCacheStr}`;
const headingsCacheKey = node => `transformer-remark-markdown-headings-${node.internal.contentDigest}-${pluginsCacheStr}`;
const tableOfContentsCacheKey = node => `transformer-remark-markdown-toc-${node.internal.contentDigest}-${pluginsCacheStr}`;

module.exports = ({ type, store, pathPrefix, getNode, cache }, pluginOptions) => {
  if (type.name !== `Whoa`) {
    return {};
  }

  pluginsCacheStr = pluginOptions.plugins.map(p => p.name).join(``);

  return new Promise((resolve, reject) => {
    // Setup Remark.
    let remark = new Remark().data(`settings`, {
      commonmark: true,
      footnotes: true,
      pedantic: true
    });

    remark = remark.use(whoa);

    let mutatedUnified = unified().use(parse).use(whoa);

    for (let plugin of pluginOptions.plugins) {
      const requiredPlugin = require(plugin.resolve);
      if (_.isFunction(requiredPlugin.setParserPlugins)) {
        for (let parserPlugin of requiredPlugin.setParserPlugins()) {
          remark = remark.use(parserPlugin);
          mutatedUnified = mutatedUnified.use(parserPlugin);
        }
      }
    }

    async function getAST(markdownNode) {
      const cachedAST = await cache.get(astCacheKey(markdownNode));
      if (cachedAST) {
        return cachedAST;
      } else {
        const files = _.values(store.getState().nodes).filter(n => n.internal.type === `File`);

        const ast = await new Promise((resolve, reject) => {
          Promise.all(pluginOptions.plugins.map(plugin => {
            const requiredPlugin = require(plugin.resolve);
            if (_.isFunction(requiredPlugin.mutateSource)) {
              return requiredPlugin.mutateSource({
                markdownNode,
                files,
                getNode
              }, plugin.pluginOptions);
            } else {
              return Promise.resolve();
            }
          })).then(async () => {
            const markdownAST = remark.parse(markdownNode.internal.content);

            /** 💁 this is how I am doing in file styling and components, right now at least */
            /** ⚠️ This is not exactly the best place for this, it should exist as part of the whoa parser. I can't just use <style> tags because they don't come out well when they are multiple lines. */
            visit(markdownAST, `code`, node => {
              if (node.lang) {
                if (node.lang === 'style') {
                  node.type = 'style';
                } else if (node.lang.includes('component')) {
                  node.type = 'component';
                }
              }
            });

            // source => parse (can order parsing for dependencies) => typegen
            //
            // source plugins identify nodes, provide id, initial parse, know
            // when nodes are created/removed/deleted
            // get passed cached DataTree and return list of clean and dirty nodes.
            // Also get passed `dirtyNodes` function which they can call with an array
            // of node ids which will then get re-parsed and the inferred schema
            // recreated (if inferring schema gets too expensive, can also
            // cache the schema until a query fails at which point recreate the
            // schema).
            //
            // parse plugins take data from source nodes and extend it, never mutate
            // it. Freeze all nodes once done so typegen plugins can't change it
            // this lets us save off the DataTree at that point as well as create
            // indexes.
            //
            // typegen plugins identify further types of data that should be lazily
            // computed due to their expense, or are hard to infer graphql type
            // (markdown ast), or are need user input in order to derive e.g.
            // markdown headers or date fields.
            //
            // wrap all resolve functions to (a) auto-memoize and (b) cache to disk any
            // resolve function that takes longer than ~10ms (do research on this
            // e.g. how long reading/writing to cache takes), and (c) track which
            // queries are based on which source nodes. Also if connection of what
            // which are always rerun if their underlying nodes change..
            //
            // every node type in DataTree gets a schema type automatically.
            // typegen plugins just modify the auto-generated types to add derived fields
            // as well as computationally expensive fields.
            const files = _.values(store.getState().nodes).filter(n => n.internal.type === `File`);
            Promise.all(pluginOptions.plugins.map(plugin => {
              const requiredPlugin = require(plugin.resolve);
              if (_.isFunction(requiredPlugin)) {
                return requiredPlugin({
                  markdownAST,
                  markdownNode,
                  getNode,
                  files,
                  pathPrefix
                }, plugin.pluginOptions);
              } else {
                return Promise.resolve();
              }
            })).then(() => {
              resolve(markdownAST);
            });
          });
        });

        // Save new AST to cache and return
        cache.set(astCacheKey(markdownNode), ast);

        return ast;
      }
    }

    async function getHeadings(markdownNode) {
      const cachedHeadings = await cache.get(headingsCacheKey(markdownNode));
      if (cachedHeadings) {
        return cachedHeadings;
      } else {
        const ast = await getAST(markdownNode);
        const headings = select(ast, `heading`).map(heading => {
          return {
            value: _.first(select(heading, `text`).map(text => text.value)),
            depth: heading.depth
          };
        });

        cache.set(headingsCacheKey(markdownNode), headings);
        return headings;
      }
    }

    async function getTableOfContents(markdownNode) {
      const cachedToc = await cache.get(tableOfContentsCacheKey(markdownNode));
      if (cachedToc) {
        return cachedToc;
      } else {
        const ast = await getAST(markdownNode);
        const tocAst = mdastToToc(ast);
        let toc;
        if (tocAst.map) {
          toc = hastToHTML(toHAST(tocAst.map));
        } else {
          toc = ``;
        }
        cache.set(tableOfContentsCacheKey(markdownNode), toc);
        return toc;
      }
    }

    async function getHTML(markdownNode) {
      const cachedHTML = await cache.get(htmlCacheKey(markdownNode));
      if (cachedHTML) {
        return cachedHTML;
      } else {
        const html = await new Promise((resolve, reject) => {
          getAST(markdownNode).then(ast => {
            resolve(hastToHTML(toHAST(ast, { allowDangerousHTML: true }), {
              allowDangerousHTML: true
            }));
          });
        });

        // Save new HTML to cache and return
        cache.set(htmlCacheKey(markdownNode), html);
        return html;
      }
    }

    const HeadingType = new GraphQLObjectType({
      name: `MarkdownHeading`,
      fields: {
        value: {
          type: GraphQLString,
          resolve(heading) {
            return heading.value;
          }
        },
        depth: {
          type: GraphQLInt,
          resolve(heading) {
            return heading.depth;
          }
        }
      }
    });

    const HeadingLevels = new GraphQLEnumType({
      name: `HeadingLevels`,
      values: {
        h1: { value: 1 },
        h2: { value: 2 },
        h3: { value: 3 },
        h4: { value: 4 },
        h5: { value: 5 },
        h6: { value: 6 }
      }
    });

    return resolve({
      html: {
        type: GraphQLString,
        resolve(markdownNode) {
          return getHTML(markdownNode);
        }
      },
      ast: {
        type: GraphQLString,
        resolve(markdownNode) {
          return getAST(markdownNode).then(ast => JSON.stringify(ast));
          // JSON.stringify(
          //   mutatedUnified().parse(
          //     frontmatter(markdownNode.internal.content).body
          //   )
          // )
          // .getAST(markdownNode).then(ast => JSON.stringify(ast))
        }
      },
      excerpt: {
        type: GraphQLString,
        args: {
          pruneLength: {
            type: GraphQLInt,
            defaultValue: 140
          }
        },
        resolve(markdownNode, { pruneLength }) {
          return getAST(markdownNode).then(ast => {
            const excerptNodes = [];

            visit(ast, node => {
              if (node.type === `text` || node.type === `inlineCode`) {
                excerptNodes.push(node.value);
              }
              return;
            });

            return prune(excerptNodes.join(` `), pruneLength, `…`);
          });
        }
      },
      headings: {
        type: new GraphQLList(HeadingType),
        args: {
          depth: {
            type: HeadingLevels
          }
        },
        resolve(markdownNode, { depth }) {
          return getHeadings(markdownNode).then(headings => {
            if (typeof depth === `number`) {
              headings = headings.filter(heading => heading.depth === depth);
            }
            return headings;
          });
        }
      },
      timeToRead: {
        type: GraphQLInt,
        resolve(markdownNode) {
          return getHTML(markdownNode).then(html => {
            let timeToRead = 0;
            const pureText = sanitizeHTML(html, {
              allowTags: [],
              // doesn't work because things are going wrong in
              transformTags: {
                search: 'p',
                normative: 'span',
                wordChoice: 'span',
                redaction: 'span',
                tangent: 'span',
                revision: 'span',
                timelapse: 'p'
              }
            });
            const avgWPM = 265;
            const wordCount = _.words(pureText).length;
            timeToRead = Math.round(wordCount / avgWPM);
            if (timeToRead === 0) {
              timeToRead = 1;
            }
            return timeToRead;
          });
        }
      },
      tableOfContents: {
        type: GraphQLString,
        resolve(markdownNode) {
          return getTableOfContents(markdownNode);
        }
      },
      // TODO add support for non-latin languages https://github.com/wooorm/remark/issues/251#issuecomment-296731071
      // ⚠️ Naive
      wordCount: {
        type: new GraphQLObjectType({
          name: `wordCount`,
          fields: {
            words: {
              type: GraphQLInt
            }
          }
          // fields: {
          //   paragraphs: {
          //     type: GraphQLInt,
          //   },
          //   sentences: {
          //     type: GraphQLInt,
          //   },
          //   words: {
          //     type: GraphQLInt,
          //   },
          // },
        }),
        resolve(markdownNode) {
          // let counts = {};

          // unified()
          //   .use(parse)
          //   .use(whoa)
          //   .use(
          //     remark2retext,
          //     unified()
          //       .use(english)
          //       .use(count)
          //   )
          //   .use(stringify)
          //   .processSync(markdownNode.internal.content);

          return {
            // paragraphs: counts.ParagraphNode,
            // sentences: counts.SentenceNode,
            words: _.words(markdownNode.internal.content).length //counts.WordNode,
          };

          function count() {
            return counter;
            function counter(tree) {
              visit(tree, visitor);
              function visitor(node) {
                counts[node.type] = (counts[node.type] || 0) + 1;
              }
            }
          }
        }
      }
    });
  });
};