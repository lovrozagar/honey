import "reflect-metadata"
import {
	Body,
	Controller,
	Get,
	Injectable,
	type MiddlewareConsumer,
	Module,
	type NestMiddleware,
	type NestModule,
	Param,
	Post,
	Req,
} from "@nestjs/common"
import { NestFactory } from "@nestjs/core"
import type { NextFunction, Request, Response } from "express"
import * as z from "zod"

const body = z.object({ age: z.number(), name: z.string() })

type TimedRequest = Request & { startedAt: number }

@Injectable()
class TimingMiddleware implements NestMiddleware {
	use(req: TimedRequest, _res: Response, next: NextFunction) {
		req.startedAt = performance.now()
		next()
	}
}

@Controller()
class AppController {
	@Get("json")
	json() {
		return { message: "Hello, World!" }
	}

	@Get("params/:id")
	params(@Param("id") id: string) {
		return { id }
	}

	@Post("validate")
	validate(@Body() raw: unknown) {
		const parsed = body.parse(raw)
		return { age: parsed.age, name: parsed.name }
	}

	@Get("middleware")
	middleware(@Req() req: TimedRequest) {
		return { elapsed: performance.now() - req.startedAt }
	}
}

@Module({ controllers: [AppController] })
class AppModule implements NestModule {
	configure(consumer: MiddlewareConsumer) {
		consumer.apply(TimingMiddleware).forRoutes("middleware")
	}
}

const port = Number(process.env.PORT ?? 3104)
const app = await NestFactory.create(AppModule, { logger: false })
await app.listen(port, "0.0.0.0")
console.log(`nest on :${port}`)
