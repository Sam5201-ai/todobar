// 静态资源模块声明(无依赖,不依赖 vite/client 类型包)
declare module '*.png' {
  const src: string
  export default src
}
declare module '*.jpg' {
  const src: string
  export default src
}
declare module '*.svg' {
  const src: string
  export default src
}
