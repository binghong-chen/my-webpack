const fs = require("fs");
const path = require("path");
const babylon = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const babel = require("@babel/core");

let ID = 0;
//  读取文件信息，并获得当前js文件的依赖关系
async function createAsset(filename) {
  // 读取文件，返回值是字符串
  const content = fs.readFileSync(filename, "utf-8");

  // 将字符串转化为AST（抽象语法树）
  // babylon 这个工具是负责解析字符串并产生AST
  const ast = babylon.parse(content, {
    sourceType: "module",
  });

  // 用来存储 文件所依赖的模块，简单来说就是，当前js文件 import 了哪些文件，都会保存在这个数组里
  const dependencies = [];

  // 遍历当前AST
  traverse(ast, {
    // 找到有 import 语法的对应节点
    ImportDeclaration: ({ node }) => {
      // 把当前依赖的模块加入到数组中，其实这存的是字符串
      // 例如，如果当前js文件有一句 import message from './message.js'
      // './message.js' === node.source.value
      dependencies.push(node.source.value);
    },
  });

  // 模块的id 从0开始，当前一个js文件可以看成一个模块
  const id = ID++;

  // ES6 -> ES5
  const { code } = await babel.transformFromAstAsync(ast, content, {
    presets: ["@babel/preset-env"],
  });

  return {
    id,
    filename,
    dependencies,
    code,
  };
}

// 从入口开始分析所有依赖项，形成依赖图，采用广度优先遍历（BFS）
async function createGraph(entry) {
  const mainAsset = await createAsset(entry);

  // BFS 需要一个队列，第一个元素就是 入口 entry 返回的信息
  const queue = [mainAsset];

  for (const asset of queue) {
    const dirname = path.dirname(asset.filename);

    // 新增一个属性来保存子依赖项的数据
    // 保存类似 这样的数据结构 ---> {'./message.js': 1}
    asset.mapping = {};

    await Promise.all(
      asset.dependencies.map(async (relativePath) => {
        const absolutePath = path.join(dirname, relativePath);

        // 获得子依赖（子模块）的依赖项、代码、模块id、文件名
        const child = await createAsset(absolutePath);

        asset.mapping[relativePath] = child.id;

        // 将子依赖也加入队列中，进行广度优先遍历
        queue.push(child);
      })
    );
  }
  return queue;
}

// 根据生成的依赖关系图，生成对应环境能执行的代码，目前是生产浏览器可执行的
function bunlde(graph) {
  let modules = "";

  // 循环依赖关系，并把每个模块中的代码存在function作用域里
  graph.forEach((mod) => {
    modules += `${mod.id}: [
      function (require, module, exports) {
        ${mod.code}
      },
      ${JSON.stringify(mod.mapping)}
    ],`;
  });

  // require, module, exports 是 cjs的标准，不能在浏览器中直接使用，所以这里模拟cjs模块加载、执行、导出
  const result = `
    (function(modules) {
      // 创建require函数，它接受一个模块ID（数字0，1，2），它会在我们上面定义modules中找到对应的模块
      function require(id) {
        const [fn, mapping] = modules[id];
        function localRequire(relativePath) {
          // 根据模块的路径在mapping中找到相应的模块id
          return require(mapping[relativePath]);
        }
        const module = { exports: {} };
        // 执行每个模块的代码
        fn(localRequire, module, module.exports);
        return module.exports;
      }
      // 执行入口文件
      require(0);
    })({${modules}})
  `;

  return result;
}

(async () => {
  const graph = await createGraph("./example/entry.js");
  const ret = bunlde(graph);

  // 打包生成文件
  fs.writeFileSync("./bundle.js", ret);
})();
