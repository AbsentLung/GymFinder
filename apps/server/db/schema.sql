--
-- PostgreSQL database dump
--

\restrict DlbdIfY7bGzcgYWNnl9kcYOMJfmu81xaugspClsKzHEdWs1eWCgY4nJ1vXzKe7i

-- Dumped from database version 16.14 (Homebrew)
-- Dumped by pg_dump version 16.14 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: gym_data_source; Type: TYPE; Schema: public; Owner: joey
--

CREATE TYPE public.gym_data_source AS ENUM (
    'osm',
    'bot_verified',
    'admin_verified'
);


ALTER TYPE public.gym_data_source OWNER TO joey;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admins; Type: TABLE; Schema: public; Owner: joey
--

CREATE TABLE public.admins (
    id bigint NOT NULL,
    name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.admins OWNER TO joey;

--
-- Name: admins_id_seq; Type: SEQUENCE; Schema: public; Owner: joey
--

CREATE SEQUENCE public.admins_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.admins_id_seq OWNER TO joey;

--
-- Name: admins_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: joey
--

ALTER SEQUENCE public.admins_id_seq OWNED BY public.admins.id;


--
-- Name: categories; Type: TABLE; Schema: public; Owner: joey
--

CREATE TABLE public.categories (
    id smallint NOT NULL,
    label text NOT NULL
);


ALTER TABLE public.categories OWNER TO joey;

--
-- Name: fetched_areas; Type: TABLE; Schema: public; Owner: joey
--

CREATE TABLE public.fetched_areas (
    id integer NOT NULL,
    min_lat double precision NOT NULL,
    min_lng double precision NOT NULL,
    max_lat double precision NOT NULL,
    max_lng double precision NOT NULL,
    last_fetched_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.fetched_areas OWNER TO joey;

--
-- Name: fetched_areas_id_seq; Type: SEQUENCE; Schema: public; Owner: joey
--

CREATE SEQUENCE public.fetched_areas_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.fetched_areas_id_seq OWNER TO joey;

--
-- Name: fetched_areas_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: joey
--

ALTER SEQUENCE public.fetched_areas_id_seq OWNED BY public.fetched_areas.id;


--
-- Name: gym_categories; Type: TABLE; Schema: public; Owner: joey
--

CREATE TABLE public.gym_categories (
    gym_id integer NOT NULL,
    category_id smallint NOT NULL
);


ALTER TABLE public.gym_categories OWNER TO joey;

--
-- Name: gym_submission_statuses; Type: TABLE; Schema: public; Owner: joey
--

CREATE TABLE public.gym_submission_statuses (
    id smallint NOT NULL,
    label text NOT NULL
);


ALTER TABLE public.gym_submission_statuses OWNER TO joey;

--
-- Name: gym_submissions; Type: TABLE; Schema: public; Owner: joey
--

CREATE TABLE public.gym_submissions (
    id bigint NOT NULL,
    gym_id integer,
    submitted_by_name text NOT NULL,
    submission_type text DEFAULT 'new_gym'::text NOT NULL,
    payload jsonb NOT NULL,
    status_id smallint DEFAULT 1 NOT NULL,
    approved_by bigint,
    approved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    description text,
    submitted_by_user_id bigint,
    CONSTRAINT gym_submissions_submission_type_check CHECK ((submission_type = ANY (ARRAY['new_gym'::text, 'edit'::text, 'admin_request'::text])))
);


ALTER TABLE public.gym_submissions OWNER TO joey;

--
-- Name: gym_submissions_id_seq; Type: SEQUENCE; Schema: public; Owner: joey
--

CREATE SEQUENCE public.gym_submissions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.gym_submissions_id_seq OWNER TO joey;

--
-- Name: gym_submissions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: joey
--

ALTER SEQUENCE public.gym_submissions_id_seq OWNED BY public.gym_submissions.id;


--
-- Name: gyms; Type: TABLE; Schema: public; Owner: joey
--

CREATE TABLE public.gyms (
    id integer NOT NULL,
    name text NOT NULL,
    lat double precision NOT NULL,
    lng double precision NOT NULL,
    rating numeric(2,1),
    description text,
    day_pass_price_cents integer,
    week_pass_price_cents integer,
    month_pass_price_cents integer,
    trial_days integer,
    trial_details text,
    osm_id bigint,
    data_source public.gym_data_source DEFAULT 'osm'::public.gym_data_source NOT NULL,
    address text,
    accepts_drop_in boolean,
    created_by_user_id bigint,
    updated_by_user_id bigint
);


ALTER TABLE public.gyms OWNER TO joey;

--
-- Name: gyms_id_seq; Type: SEQUENCE; Schema: public; Owner: joey
--

CREATE SEQUENCE public.gyms_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.gyms_id_seq OWNER TO joey;

--
-- Name: gyms_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: joey
--

ALTER SEQUENCE public.gyms_id_seq OWNED BY public.gyms.id;


--
-- Name: reviews; Type: TABLE; Schema: public; Owner: joey
--

CREATE TABLE public.reviews (
    id integer NOT NULL,
    gym_id integer NOT NULL,
    author text NOT NULL,
    rating integer NOT NULL,
    body text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reviews_rating_check CHECK (((rating >= 1) AND (rating <= 5)))
);


ALTER TABLE public.reviews OWNER TO joey;

--
-- Name: reviews_id_seq; Type: SEQUENCE; Schema: public; Owner: joey
--

CREATE SEQUENCE public.reviews_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.reviews_id_seq OWNER TO joey;

--
-- Name: reviews_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: joey
--

ALTER SEQUENCE public.reviews_id_seq OWNED BY public.reviews.id;


--
-- Name: scanned_areas; Type: TABLE; Schema: public; Owner: joey
--

CREATE TABLE public.scanned_areas (
    id integer NOT NULL,
    min_lat double precision NOT NULL,
    min_lng double precision NOT NULL,
    max_lat double precision NOT NULL,
    max_lng double precision NOT NULL,
    scanned_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.scanned_areas OWNER TO joey;

--
-- Name: scanned_areas_id_seq; Type: SEQUENCE; Schema: public; Owner: joey
--

CREATE SEQUENCE public.scanned_areas_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.scanned_areas_id_seq OWNER TO joey;

--
-- Name: scanned_areas_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: joey
--

ALTER SEQUENCE public.scanned_areas_id_seq OWNED BY public.scanned_areas.id;


--
-- Name: unverified_gym_data; Type: TABLE; Schema: public; Owner: joey
--

CREATE TABLE public.unverified_gym_data (
    gym_id integer NOT NULL,
    day_pass_price_cents integer,
    week_pass_price_cents integer,
    month_pass_price_cents integer,
    pricing_note text,
    trial_days integer,
    trial_details text,
    source text,
    scraped_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.unverified_gym_data OWNER TO joey;

--
-- Name: users; Type: TABLE; Schema: public; Owner: joey
--

CREATE TABLE public.users (
    id bigint NOT NULL,
    email text NOT NULL,
    password_hash text,
    name text NOT NULL,
    auth_provider text DEFAULT 'email'::text NOT NULL,
    is_admin boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT users_auth_provider_check CHECK ((auth_provider = ANY (ARRAY['email'::text, 'google'::text, 'facebook'::text])))
);


ALTER TABLE public.users OWNER TO joey;

--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: joey
--

CREATE SEQUENCE public.users_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.users_id_seq OWNER TO joey;

--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: joey
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: admins id; Type: DEFAULT; Schema: public; Owner: joey
--

ALTER TABLE ONLY public.admins ALTER COLUMN id SET DEFAULT nextval('public.admins_id_seq'::regclass);


--
-- Name: fetched_areas id; Type: DEFAULT; Schema: public; Owner: joey
--

ALTER TABLE ONLY public.fetched_areas ALTER COLUMN id SET DEFAULT nextval('public.fetched_areas_id_seq'::regclass);


--
-- Name: gym_submissions id; Type: DEFAULT; Schema: public; Owner: joey
--

ALTER TABLE ONLY public.gym_submissions ALTER COLUMN id SET DEFAULT nextval('public.gym_submissions_id_seq'::regclass);


--
-- Name: gyms id; Type: DEFAULT; Schema: public; Owner: joey
--

ALTER TABLE ONLY public.gyms ALTER COLUMN id SET DEFAULT nextval('public.gyms_id_seq'::regclass);


--
-- Name: reviews id; Type: DEFAULT; Schema: public; Owner: joey
--

ALTER TABLE ONLY public.reviews ALTER COLUMN id SET DEFAULT nextval('public.reviews_id_seq'::regclass);


--
-- Name: scanned_areas id; Type: DEFAULT; Schema: public; Owner: joey
--

ALTER TABLE ONLY public.scanned_areas ALTER COLUMN id SET DEFAULT nextval('public.scanned_areas_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: joey
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Name: admins admins_pkey; Type: CONSTRAINT; Schema: public; Owner: joey
--

ALTER TABLE ONLY public.admins
    ADD CONSTRAINT admins_pkey PRIMARY KEY (id);


--
-- Name: categories categories_label_key; Type: CONSTRAINT; Schema: public; Owner: joey
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_label_key UNIQUE (label);


--
-- Name: categories categories_pkey; Type: CONSTRAINT; Schema: public; Owner: joey
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_pkey PRIMARY KEY (id);


--
-- Name: fetched_areas fetched_areas_pkey; Type: CONSTRAINT; Schema: public; Owner: joey
--

ALTER TABLE ONLY public.fetched_areas
    ADD CONSTRAINT fetched_areas_pkey PRIMARY KEY (id);


--
-- Name: gym_categories gym_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: joey
--

ALTER TABLE ONLY public.gym_categories
    ADD CONSTRAINT gym_categories_pkey PRIMARY KEY (gym_id, category_id);


--
-- Name: gym_submission_statuses gym_submission_statuses_pkey; Type: CONSTRAINT; Schema: public; Owner: joey
--

ALTER TABLE ONLY public.gym_submission_statuses
    ADD CONSTRAINT gym_submission_statuses_pkey PRIMARY KEY (id);


--
-- Name: gym_submissions gym_submissions_pkey; Type: CONSTRAINT; Schema: public; Owner: joey
--

ALTER TABLE ONLY public.gym_submissions
    ADD CONSTRAINT gym_submissions_pkey PRIMARY KEY (id);


--
-- Name: gyms gyms_osm_id_key; Type: CONSTRAINT; Schema: public; Owner: joey
--

ALTER TABLE ONLY public.gyms
    ADD CONSTRAINT gyms_osm_id_key UNIQUE (osm_id);


--
-- Name: gyms gyms_pkey; Type: CONSTRAINT; Schema: public; Owner: joey
--

ALTER TABLE ONLY public.gyms
    ADD CONSTRAINT gyms_pkey PRIMARY KEY (id);


--
-- Name: reviews reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: joey
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_pkey PRIMARY KEY (id);


--
-- Name: scanned_areas scanned_areas_pkey; Type: CONSTRAINT; Schema: public; Owner: joey
--

ALTER TABLE ONLY public.scanned_areas
    ADD CONSTRAINT scanned_areas_pkey PRIMARY KEY (id);


--
-- Name: unverified_gym_data unverified_gym_data_pkey; Type: CONSTRAINT; Schema: public; Owner: joey
--

ALTER TABLE ONLY public.unverified_gym_data
    ADD CONSTRAINT unverified_gym_data_pkey PRIMARY KEY (gym_id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: joey
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: joey
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: idx_fetched_areas_bbox; Type: INDEX; Schema: public; Owner: joey
--

CREATE INDEX idx_fetched_areas_bbox ON public.fetched_areas USING btree (min_lat, max_lat, min_lng, max_lng);


--
-- Name: idx_gym_submissions_pending; Type: INDEX; Schema: public; Owner: joey
--

CREATE INDEX idx_gym_submissions_pending ON public.gym_submissions USING btree (created_at) WHERE (status_id = ANY (ARRAY[1, 2]));


--
-- Name: idx_scanned_areas_bbox; Type: INDEX; Schema: public; Owner: joey
--

CREATE INDEX idx_scanned_areas_bbox ON public.scanned_areas USING btree (min_lat, max_lat, min_lng, max_lng);


--
-- Name: gym_categories gym_categories_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: joey
--

ALTER TABLE ONLY public.gym_categories
    ADD CONSTRAINT gym_categories_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id);


--
-- Name: gym_categories gym_categories_gym_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: joey
--

ALTER TABLE ONLY public.gym_categories
    ADD CONSTRAINT gym_categories_gym_id_fkey FOREIGN KEY (gym_id) REFERENCES public.gyms(id) ON DELETE CASCADE;


--
-- Name: gym_submissions gym_submissions_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: joey
--

ALTER TABLE ONLY public.gym_submissions
    ADD CONSTRAINT gym_submissions_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.admins(id);


--
-- Name: gym_submissions gym_submissions_gym_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: joey
--

ALTER TABLE ONLY public.gym_submissions
    ADD CONSTRAINT gym_submissions_gym_id_fkey FOREIGN KEY (gym_id) REFERENCES public.gyms(id);


--
-- Name: gym_submissions gym_submissions_status_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: joey
--

ALTER TABLE ONLY public.gym_submissions
    ADD CONSTRAINT gym_submissions_status_id_fkey FOREIGN KEY (status_id) REFERENCES public.gym_submission_statuses(id);


--
-- Name: gym_submissions gym_submissions_submitted_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: joey
--

ALTER TABLE ONLY public.gym_submissions
    ADD CONSTRAINT gym_submissions_submitted_by_user_id_fkey FOREIGN KEY (submitted_by_user_id) REFERENCES public.users(id);


--
-- Name: gyms gyms_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: joey
--

ALTER TABLE ONLY public.gyms
    ADD CONSTRAINT gyms_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id);


--
-- Name: gyms gyms_updated_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: joey
--

ALTER TABLE ONLY public.gyms
    ADD CONSTRAINT gyms_updated_by_user_id_fkey FOREIGN KEY (updated_by_user_id) REFERENCES public.users(id);


--
-- Name: reviews reviews_gym_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: joey
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_gym_id_fkey FOREIGN KEY (gym_id) REFERENCES public.gyms(id) ON DELETE CASCADE;


--
-- Name: unverified_gym_data unverified_gym_data_gym_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: joey
--

ALTER TABLE ONLY public.unverified_gym_data
    ADD CONSTRAINT unverified_gym_data_gym_id_fkey FOREIGN KEY (gym_id) REFERENCES public.gyms(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict DlbdIfY7bGzcgYWNnl9kcYOMJfmu81xaugspClsKzHEdWs1eWCgY4nJ1vXzKe7i

