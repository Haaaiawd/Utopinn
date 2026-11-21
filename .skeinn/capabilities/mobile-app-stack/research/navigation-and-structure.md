# 导航选型:expo-router vs React Navigation

Source: Expo 官方 app-navigation 文档、React Navigation 官方 "Moving from Expo Router" 对照文档、Viewlytics 2025 对比、Asutosh "WhatsApp-style chat app with Expo Router" 架构文

官方立场:Expo 项目默认推荐 Expo Router(SDK 58 的 create-expo-app 模板即内置)。它是 React Navigation 之上的文件式路由层:app/ 目录即路由树,自带 deep linking、typed routes、native-tabs(SDK 58 转正)。对本项目底导航四页(对话/角色/面板/我的)+ 页内 stack 的形态,文件树即信息架构,自带自文档性。

React Navigation 的相对优势在:导航状态对象模型(而非 URL)能做更精细的控制——导航状态持久化、复杂 reset、URL 与 UI 解耦。对本项目这些优势不关键:我们的"路由"基本是 app 内结构,不是公开 URL;deep link 需求(luker://endpoint 类)expo-router 原生覆盖。反例:若未来要做复杂的"恢复上次会话现场"导航状态持久化,React Navigation 的状态模型更合适——可后迁,代价中等。
